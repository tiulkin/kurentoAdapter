import Kurento from './kurento';
import EventEmitter from 'events';


//const eventsEmitter = new EventEmitter();
const eventsEmitter = { emit: (event, data) => {
    console.log(event, data);
}};
const config = {
    roomServerUrl: 'wss://kms.smart-university.ru/room',
    roomId: 'room1',
    userId: location.hash === '#1' ? 'user1' : 'user2',
    remoteUserId: location.hash !== '#1' ? 'user1' : 'user2',
    eventEmitter: eventsEmitter,
    logEventName: 'kurentoLogRecord',
    localVideoParentElement: document.getElementById('local'),
    remoteVideoParentElement: document.getElementById('remote')
};

const kurento = new Kurento(config);

//eventsEmitter.`` addEventListener(config.logEventName,

config.localVideoParentElement.addEventListener('dblclick', kurento.closeLocalConnection);
// config.remoteVideoParentElement.addEventListener('dblclick', kurento.peerConnections[config.remoteUserId].destroy);


config.localVideoParentElement.addEventListener('click', kurento.setLocalVideoDisabled.bind(null,false));
config.remoteVideoParentElement.addEventListener('click', kurento.setRemoteVideoDisabled.bind(null,false));
