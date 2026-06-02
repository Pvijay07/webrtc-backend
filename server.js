console.log('=== server.js starting ===');
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const jwt = require("jsonwebtoken");
const { spawn } = require("child_process");
const dgram = require("dgram");
const os = require("os");
const https = require("https");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Serve static files from the public directory
app.use(express.static("public"));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', port: process.env.PORT || 3000 });
});

// Mediasoup Config
const mediaCodecs = [
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];

let worker;
let router;
let webRtcServer;

// Helper to get local IP if PUBLIC_IP isn't set (useful for local testing)
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (let dev in ifaces) {
    const iface = ifaces[dev].filter(
      (details) => details.family === "IPv4" && !details.internal,
    );
    if (iface.length > 0) return iface[0].address;
  }
  return "127.0.0.1";
}

const PUBLIC_IP = process.env.PUBLIC_IP || getLocalIp();

async function getExternalIp() {
  return new Promise((resolve) => {
    const req = https.get("https://api.ipify.org", { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", () => resolve(PUBLIC_IP));
    req.on("timeout", () => {
      req.destroy();
      resolve(PUBLIC_IP);
    });
  });
}

let announcedIp = PUBLIC_IP;

async function createWorker() {
  if (!process.env.PUBLIC_IP) {
    try {
      announcedIp = await getExternalIp();
      console.log("Using announced IP for WebRTC:", announcedIp);
    } catch (e) {
      console.error("Failed to get external IP:", e);
    }
  }

  worker = await mediasoup.createWorker({
    logLevel: "warn",
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    rtcMinPort: 10000,
    rtcMaxPort: 10100, // Reduced range for testing, increase for prod (e.g. 59999)
  });

  worker.on("died", () => {
    console.error(
      "mediasoup worker died, exiting in 2 seconds... [pid:%d]",
      worker.pid,
    );
    setTimeout(() => process.exit(1), 2000);
  });

  if (
    process.env.RAILWAY_TCP_PROXY_DOMAIN &&
    process.env.RAILWAY_TCP_PROXY_PORT
  ) {
    let tcpPort = parseInt(process.env.WEBRTC_TCP_PORT || "40001", 10);
    const httpPort = parseInt(process.env.PORT || "3000", 10);
    if (tcpPort === httpPort) {
      tcpPort = httpPort + 1;
    }
    try {
      webRtcServer = await worker.createWebRtcServer({
        listenInfos: [
          {
            protocol: "tcp",
            ip: "0.0.0.0",
            announcedAddress: process.env.RAILWAY_TCP_PROXY_DOMAIN,
            port: tcpPort,
          },
        ],
      });
      console.log(
        `WebRtcServer started on TCP ${tcpPort}, external: ${process.env.RAILWAY_TCP_PROXY_DOMAIN}:${process.env.RAILWAY_TCP_PROXY_PORT}`,
      );
    } catch (e) {
      console.error("Failed to create WebRtcServer", e);
    }
  }

  router = await worker.createRouter({ mediaCodecs });
  console.log("Mediasoup router created");
}

// Start HTTP server first so Railway sees the port immediately
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebRTC backend listening on port ${PORT}`);
  // Initialize mediasoup AFTER the HTTP server is up
  createWorker().catch(err => {
    console.error('Failed to create mediasoup worker:', err);
  });
});

// We map camera_id to a specific ffmpeg process and mediasoup producer
// So if multiple users watch the same camera, we only ingest it once.
const streams = new Map(); // camera_id -> { producer, ffmpeg, consumers: [] }

async function startStream(camera_id, rtsp_url) {
  if (streams.has(camera_id)) {
    return streams.get(camera_id).producer;
  }

  console.log(`Starting FFmpeg ingestion for camera ${camera_id}...`);

  // Create PlainTransport to receive RTP from FFmpeg
  const plainTransport = await router.createPlainTransport({
    listenIp: "0.0.0.0", // FFmpeg sends here
    rtcpMux: false,
    comedia: true, // This is crucial so Mediasoup learns FFmpeg's IP/port when FFmpeg sends the first packet
  });

  const rtpPort = plainTransport.tuple.localPort;
  const rtcpPort = plainTransport.rtcpTuple
    ? plainTransport.rtcpTuple.localPort
    : rtpPort + 1;

  console.log(
    `PlainTransport created, listening on rtpPort: ${rtpPort}, rtcpPort: ${rtcpPort}`,
  );

  // FFmpeg command to pull RTSP and push RTP
  const ffmpegArgs = [
    "-rtsp_transport",
    "tcp",
    "-i",
    rtsp_url,
    "-vcodec",
    "copy",
    "-f",
    "tee",
    `[select=v:f=rtp:ssrc=111111:payload_type=96]rtp://127.0.0.1:${rtpPort}`,
  ];

  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

  ffmpegProcess.stderr.on("data", (data) => {
    // FFmpeg logs to stderr
    console.log(`[FFmpeg ${camera_id}]: ${data.toString()}`);
  });

  ffmpegProcess.on("close", (code) => {
    console.log(
      `FFmpeg process for camera ${camera_id} exited with code ${code}`,
    );
    streams.delete(camera_id);
    plainTransport.close();
  });

  // Create a Producer for this incoming RTP stream
  const producer = await plainTransport.produce({
    kind: "video",
    rtpParameters: {
      codecs: [
        {
          mimeType: "video/H264",
          clockRate: 90000,
          payloadType: 96,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1,
          },
        },
      ],
      encodings: [{ ssrc: 111111 }], // Arbitrary SSRC
    },
  });

  streams.set(camera_id, { producer, ffmpegProcess, plainTransport });

  return producer;
}

io.on("connection", async (socket) => {
  // const token = socket.handshake.query.token;

  // if (!token) {
  //   socket.disconnect();
  //   return;
  // }

  let payload = {
    camera_id: "2",
    rtsp_url:
      "rtsp://admin:Infccpw1@tsvsc-183-82-119-59.run.pinggy-free.link:38711/cam/realmonitor?channel=2&subtype=0",
  };
  // tcp://jmfhi-183-82-119-59.run.pinggy-free.link:38711
  console.log(`Client authenticated for static camera ${payload.camera_id}`);

  let consumer;
  let transport;

  // Wait for client to request router capabilities
  socket.on("getRouterCapabilities", (cb) => {
    cb(router.rtpCapabilities);
  });

  // Client requests to create a WebRTC transport
  socket.on("createTransport", async (cb) => {
    try {
      if (webRtcServer) {
        transport = await router.createWebRtcTransport({
          webRtcServer: webRtcServer,
          enableUdp: false,
          enableTcp: true,
          preferUdp: false,
        });
      } else {
        transport = await router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: announcedIp }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });
      }

      transport.on("icestatechange", (iceState) => {
        console.log("ICE state change:", iceState);
      });

      transport.on("dtlsstatechange", (dtlsState) => {
        console.log("DTLS state change:", dtlsState);
        if (dtlsState === "closed") transport.close();
      });

      transport.on("routerclose", () => transport.close());

      let iceCandidates = transport.iceCandidates;

      if (webRtcServer && process.env.RAILWAY_TCP_PROXY_PORT) {
        const externalPort = parseInt(process.env.RAILWAY_TCP_PROXY_PORT, 10);
        iceCandidates = iceCandidates.map((c) => ({
          ...c,
          port: externalPort,
        }));
      }

      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (err) {
      console.error(err);
      cb({ error: err.message });
    }
  });

  // Connect transport via DTLS
  socket.on("connectTransport", async ({ dtlsParameters }, cb) => {
    try {
      await transport.connect({ dtlsParameters });
      cb();
    } catch (err) {
      console.error(err);
      cb({ error: err.message });
    }
  });

  // Start consuming the camera feed
  socket.on("consume", async ({ rtpCapabilities }, cb) => {
    try {
      if (
        !router.canConsume({ producerId: "dummy", rtpCapabilities }) &&
        false
      ) {
        // Note: canConsume needs actual producerId, we'll check it later
      }

      // 1. Ensure FFmpeg stream is running for this camera
      const producer = await startStream(payload.camera_id, payload.rtsp_url);

      // 2. Consume it
      consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true, // start paused
      });

      consumer.on("transportclose", () => consumer.close());
      consumer.on("producerclose", () => consumer.close());

      cb({
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (err) {
      console.error(err);
      cb({ error: err.message });
    }
  });

  socket.on("resume", async (cb) => {
    try {
      if (consumer) {
        await consumer.resume();
      }
      cb();
    } catch (err) {
      cb({ error: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected for camera ${payload.camera_id}`);
    if (consumer) consumer.close();
    if (transport) transport.close();

    // In a real app, you might want to stop the FFmpeg process if no clients remain
    // We skipped reference counting for simplicity here
  });
});

