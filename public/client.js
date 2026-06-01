import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

document.addEventListener('DOMContentLoaded', () => {
  const videoRef = document.getElementById('videoElement');
  
  // Connect to the same origin where the page is served
  const socket = io();

  let device;
  let consumerTransport;
  let consumer;

  socket.on('connect', async () => {
    console.log('Connected to WebRTC Backend!');

    socket.emit('getRouterCapabilities', async (routerRtpCapabilities) => {
      
      device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities });

      socket.emit('createTransport', async (params) => {
        if (params.error) {
           console.error('Transport error:', params.error);
           return;
        }

        consumerTransport = device.createRecvTransport(params);

        consumerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit('connectTransport', { dtlsParameters }, (res) => {
            if (res && res.error) errback(res.error);
            else callback();
          });
        });

        socket.emit('consume', { rtpCapabilities: device.rtpCapabilities }, async (params) => {
          if (params.error) {
            console.error('Consume error:', params.error);
            return;
          }

          consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters,
          });

          const stream = new MediaStream([consumer.track]);
          videoRef.srcObject = stream;
          
          socket.emit('resume', () => {
            console.log('Stream resumed, video should be playing!');
          });
        });
      });
    });
  });

  window.addEventListener('beforeunload', () => {
    socket.disconnect();
    if (consumer) consumer.close();
    if (consumerTransport) consumerTransport.close();
  });
});
