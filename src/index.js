import Kurento from './kurento';

const config = {
    roomServerUrl: 'wss://kms.smart-university.ru/room',
    roomId: 'room1',
    userId: location.hash === '#1' ? 'user1' : 'user2',
    remoteUserId: location.hash !== '#1' ? 'user1' : 'user2',
    localVideoParentElement: document.getElementById('local'),
    remoteVideoParentElement: 'remote'
};

const kurento = new Kurento(config);
console.log(kurento);

//
//
// var Peer = require('simple-peer')
//
// var peer1 = new Peer({ initiator: true })
// var peer2 = new Peer()
//
// peer1.on('signal', function (data) {
//     console.log('signal1', data);
//     // when peer1 has signaling data, give it to peer2 somehow
//     peer2.signal(data)
// })
//
// peer2.on('signal', function (data) {
//     console.log('signal2', data);
//     console.log(data);
//     // when peer2 has signaling data, give it to peer1 somehow
//     peer1.signal(data)
// })
//
// peer1.on('connect', function () {
//     // wait for 'connect' event before using the data channel
//     peer1.send('hey peer2, how is it going?')
// })
//
// peer2.on('data', function (data) {
//     // got a data channel message
//     console.log('got a message from peer1: ' + data)
// })