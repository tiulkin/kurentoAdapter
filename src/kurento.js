import Peer from 'simple-peer';
import RPCBuilder from 'kurento-jsonrpc';
import getUserMedia from 'getUserMedia';
import kurentoEventsList from './eventsList'
// to prevent hardcode any paticular event libriary we jast leave it up to caller
// the object "config.eventEmitter" must have "emit" method;
const defaultConstraints = {
    audio: true,
    video: {
        mandatory: {
            maxWidth: 640,
            maxHeight: 480,
            minWidth: 480,
            minHeight: 270,
            maxFrameRate: 15,
            minFrameRate: 1
        }
    }
};
const tryingTimeToError = 3000;
const defaultIceServers = [
    {
        "urls": ["turn:84.201.132.40:3478"],
        "username": "kurento",
        "credential": "kurentopw"
    },
    {
        "url": "stun:84.201.132.40:3478",
        "urls": ["stun:84.201.132.40:3478"]
    }
];

class KurentoAdapter {
    constructor(config) {
        this.eventEmitter = config.eventEmitter || { emit: (event => console.log(event)) };
        this.logEventName = config.logEventName;

        this.roomServerUrl = config.roomServerUrl;

        this.localVideoParentElement = config.localVideoParentElement;
        this.remoteVideoParentElement = config.remoteVideoParentElement;

        this.localStream = null;
        this.remoteStream = null;

        this.peerConnections = {};

        this.rtcConstrains = config.rtcConstrains || defaultConstraints;
        this.iceServers = config.iceServers || defaultIceServers;

        this.roomId = config.roomId;
        this.userId = config.userId;
        this.remoteUserId = config.remoteUserId;
        this.remoteUserIdKurento = config.remoteUserIdKurento;

        this.audioOnly = false;

        this.localVideoDisabled = config.localVideoDisabled;
        this.localAudioDisabled = config.localAudioDisabled;
        this.remoteVideoDisabled = config.remoteVideoDisabled;
        this.remoteAudioDisabled = config.remoteAudioDisabled;

        this.roomConnected = false;
        this.remoteUserInRoom = false;

        this.localPublished = false;
        this.isClosing = false;
        this.remotePlaying = false;

        this.reconnectRoomTime = 0;
        this.reconnectRoomTime = 0;
        this.reconnectInterval = null;

        this.start();
        // the first attempt for audio and video

    }
    log = data => {
        if (this.logEventName) this.emit(this.logEventName, data);
    };

    emit = (event, data) => {
        console.log(event, data);
        this.eventEmitter.emit(event, { data, context:this.getRoomInfo() });
    };

    start = () => {
        this.log('startingProcess');
        if (this.jsonRPCClient) {
            try {
                this.log('closingExistedJsonRPCClient');
                this.jsonRPCClient.close();
            } catch (error) {
                this.log('errorClosingExistedJsonRPCClient', error, true);
            }
        }
        if (this.peerConnections[this.userId]) {
            this.log('destroingExistedPeerConnectionLocal');
            this.localStream = null;
            this.peerConnections[this.userId].destroy();
        }
        if (this.peerConnections[this.remoteUserId]) {
            this.log('destroingExistedPeerConnectionRemote');
            this.remoteStream = null;
            this.peerConnections[this.remoteUserId].destroy();
        }
        this.showRemoteVideo(true);
        this.showLocalVideo(true);
        getUserMedia(this.rtcConstrains, (err, stream) => {
            this.log('getUserMediaWithVideo');
            if (err) {
                // the second attempt for audio only
                this.rtcConstrains.video = false;
                this.log('getUserMediaWithVideoError');
                getUserMedia(this.rtcConstrains, (err, stream) => {
                    this.log('getUserMediaWithoutVideo');
                    if (err) {
                        this.log('getUserMediaWithoutVideoError', err, true);
                    } else{
                        this.audioOnly = true;
                        this.log('gotUserMediaWithoutVideo');
                        this.initConnection(stream);
                    }
                })
            } else {
                this.log('gotUserMediaWithoutVideo');
                this.initConnection(stream);
            }
        });
    }

    initConnection = stream => {
        this.localStream =  stream;
        this.log('gotLocalStream');
        try {
            this.log('initJsonRPCClient');
            this.initJsonRPCClient();
        } catch (error) {
            this.log('initJsonRPCClientError', error, true);
        }
        clearInterval(this.reconnectInterval);
        setTimeout(() => this.reconnectInterval = setInterval(this.reconnectDeamon, 5000), 2000);
    }

    initJsonRPCClient = () => {
        const config = {
            heartbeat: 2000,
            sendCloseMessage: false,
            ws: {
                uri: this.roomServerUrl,
                useSockJS: false,
                onconnected: this.onSocketConnected,
                ondisconnect: this.onSocketDisconnected,
                onreconnecting: this.onSocketDisconnected,
                onerror: this.onSocketError
            },
            rpc: {
                requestTimeout: 2000,
                participantPublished: this.onRemotePublished,
                participantLeft: this.onParticipantLeft,
                participantEvicted: this.onParticipantEvicted,
                participantJoined: this.onParticipantJoined,
                iceCandidate: this.onIceCandidateReceived,
                mediaError: this.onSocketDisconnected
                // sendMessage: this.onSocketDisconnected,
            }
        };
        this.jsonRPCClient =  new RPCBuilder.clients.JsonRpcClient(config);
    }

    connect = () => {
        this.log('joiningToRoom');
        try {
            this.sendRequest('joinRoom', {user: this.userId, room: this.roomId}, this.onRoomConnected)
        } catch (e) {
            this.log('errorJoiningToRoom', e, true);
            setTimeout(this.connect, 1000);
        }
    };

    reconnectDeamon = () => {
        if (this.isClosing) {
            clearInterval(this.reconnectInterval);
        } else if ((!this.roomConnected || !this.localPublished || (this.remoteUserInRoom && (!this.remotePlaying ))) &&
            this.reconnectRoomTime + tryingTimeToError < new Date().getTime()) {
                    this.log('resetRoomConnection', {
                        roomConnected: this.roomConnected,
                        localPublished: this.localPublished,
                        remotePlaying: this.remotePlaying
                    });
                    this.reconnectRoomTime = new Date().getTime();
                    this.start();
                }
    };

    closeLocalConnection = () => {
        this.log('closeLocalConnection');
        this.isClosing = true;
        this.peerConnections[this.userId].destroy();
        this.peerConnections=null;

    }
    showLocalVideo = destroyOnly => {
        const parentElement = typeof this.localVideoParentElement === 'string'
            ? document.getElementById(this.localVideoParentElement)
            : this.localVideoParentElement;

        if (this.localStream && parentElement) {
            let videoElement = parentElement.getElementsByTagName('video')[0];

            if (videoElement) {
                parentElement.removeChild(videoElement);
            }

            if(destroyOnly) return;

            videoElement = document.createElement('video');
            videoElement.autoplay = true;
            videoElement.controls = false;
            videoElement.muted = true;
            videoElement.onplay = () => this.eventEmitter.emit(kurentoEventsList.localVideo.playing, this.getRoomInfo());
            videoElement.onerror = () => this.eventEmitter.emit(kurentoEventsList.localVideo.error, this.getRoomInfo());
            videoElement.srcObject = this.localStream;

            parentElement.appendChild(videoElement);
            this.log('createdVideoElementLocal');
        }
    };

    showRemoteVideo = detsroyOnly => {
        const parentElement = typeof this.remoteVideoParentElement === 'string'
            ? document.getElementById(this.remoteVideoParentElement)
            : this.remoteVideoParentElement;

        if (this.remoteStream && parentElement) {
            let audioElement = parentElement.getElementsByTagName('audio')[0];
            let videoElement = parentElement.getElementsByTagName('video')[0];

            if (audioElement) parentElement.removeChild(audioElement);
            if (videoElement) parentElement.removeChild(videoElement);

            if (detsroyOnly) return;

            videoElement = document.createElement('video');
            videoElement.autoplay = true;
            videoElement.controls = false;
            audioElement = document.createElement('audio');
            audioElement.autoplay = true;
            audioElement.controls = false;

            videoElement.onplay = () => {
                audioElement.srcObject = null;
                this.remotePlaying = true;
                this.log('remoteVideoStarted');
            };
            videoElement.onerror = () => {
                this.log('remoteVideoError');
                this.remotePlaying = false;
            };
            audioElement.onplay = () => {
                this.log('remoteAudioStarted');
                audioElement.srcObject = null;
                this.remotePlaying = true;
            };
            audioElement.onerror = () => {
                this.remotePlaying = false;
                this.log('remoteAudioError');
            };
            audioElement.srcObject = this.remoteStream;
            videoElement.srcObject = this.remoteStream;

            parentElement.appendChild(videoElement);
            parentElement.appendChild(audioElement);

            this.setRemoteVideoDisabled(this.remoteVideoDisabled);
            this.setRemoteAudioDisabled(this.remoteAudioDisabled);
        }
    };

    setLocalVideoDisabled = value => {
        this.localStream?.getVideoTracks().forEach(track => {
            this.log(value ? 'disabledLocalVideo' : 'enabledLocalVideo');
            track.enabled = !value;
        });
    }

    setLocalAudioDisabled = value => {
        this.localStream?.getAudioTracks().forEach(track => {
            this.log(value ? 'disabledLocalAudio' : 'enabledLocalAudio');
            track.enabled = !value;
        });
    }

    setRemoteVideoDisabled = value => {
        this.remoteStream?.getVideoTracks().forEach(track =>{
            this.log(value ? 'disabledRemoteVideo' : 'enabledRemoteVideo');
            track.enabled = !value;
        });
    }

    setRemoteAudioDisabled = value => {
        this.remoteStream?.getAudioTracks().forEach(track => {
            this.log(value ? 'disabledRemoteAudio' : 'enabledRemoteAudio');
            track.enabled = !value;
        });
    }

    processRemoteUsers = users => {
        const members = users || [];
        let remoteUserId = null;

        members.forEach (member => {
            if ((member.id||'').includes(this.remoteUserId) && member.streams?.length)
                remoteUserId = `${member.id}_${member.streams[member.streams.length-1].id}`;
        });

        if (remoteUserId){
            this.remoteUserIdKurento = remoteUserId;
            this.receiveRemoteVideo(remoteUserId);
        }
    };

    onLocalVideoOfferSent = (error, response) => {
        if(error) {
            this.log('errorSendingPublishVideo', {error, response}, true);
        } else {
            this.log('gotLocalOfferAnswer', response);
            this.peerConnections[this.userId].signal({
                type: 'answer',
                sdp: response.sdpAnswer
            })

        }
    };

    onRemoteVideoOfferSent = (remoteUserId, error, response) => {
        if(error) {
            this.log('errorRemoteOfferSent', {remoteUserId, error, response}, true);
        } else {
            this.log('gotRemoteOfferAnswer', response);
            this.peerConnections[this.remoteUserId].signal({
                type: 'answer',
                sdp: response.sdpAnswer
            })

        }
    };

    onLocalVideoCandidateSent = (remoteUserId, error, response) => {
        if(error) {
            this.log('errorSendingLocalIceCandidate', {remoteUserId, error, response}, true);
        }
    };

    onRemoteVideoCandidateSent = (remoteUserId, error, response) => {
        if(error) {
            this.log('errorSendingRemoteIceCandidate', {remoteUserId, error, response}, true);
        }
    };

    publishLocalVideo = () => {
        this.log('createPeerConnectionLocal');
        this.peerConnections[this.userId] = new Peer({
            initiator: true,
            trickle: true,
            allowHalfTrickle: true,
            stream: this.localStream,
            config: { iceServers: this.iceServers},
            iceCompleteTimeout: 10000,
            offerOptions: {
                offerToReceiveAudio: false,
                offerToReceiveVideo: false
            }
        });
        // ниже костыль, выпиливающий _onChannelClose , который зачем-то уничножает весь пир апри закрытии канала данных
        this.peerConnections[this.userId]._onChannelClose = () => null;
        // ---------------------------------------------------------------------
        this.peerConnections[this.userId].on('error', err => {
            this.log('errorPeerConnectionLocal', err);
        });

        this.peerConnections[this.userId].on('signal', data => {
            if (data?.type === 'offer') {
                this.log('sendPublishVideo');
                this.sendRequest('publishVideo', {
                    sdpOffer: data.sdp,
                    doLoopback: false
                }, this.onLocalVideoOfferSent);
            }
            if (data?.candidate) {
                const dataToSend = {...data.candidate};
                dataToSend.endpointName = this.userId;
                this.log('sendOnIceCandidateLocal');
                this.sendRequest('onIceCandidate', dataToSend, this.onLocalVideoCandidateSent);
            }
        });
        this.showLocalVideo();
        this.setLocalVideoDisabled(this.localVideoDisabled);
        this.setLocalAudioDisabled(this.localAudioDisabled);

        this.peerConnections[this.userId].on('iceStateChange', status => {
            this.log('iceStateChange', status);
            switch (status) {
                case 'connected': {
                    this.localPublished = true;
                    break;
                }
                case 'failed': {
                    this.localPublished = false;
                }
            }
        });
        this.peerConnections[this.userId].on('close', () => {
            this.log('peerConnectionClosedLocal', status);
            this.localPublished = false;
        });
    };

    receiveRemoteVideo = (remoteUserId) => {
        this.remoteUserInRoom = true;

        if (this.peerConnections[this.remoteUserId]) {
            this.log('destroyingOldPeerConnectionRemote');
            this.peerConnections[this.remoteUserId].destroy();
            this.showRemoteVideo(true);
        }
        this.log('createPeerConnectionRemote', remoteUserId);
        this.peerConnections[this.remoteUserId] = new Peer({
            initiator: true,
            trickle: true,
            allowHalfTrickle: true,
            iceCompleteTimeout: 10000,
            offerOptions: {
                offerToReceiveAudio: true,
                offerToReceiveVideo: !this.audioOnly
            },
            config: { iceServers: this.iceServers }
        });
        // ниже костыль, выпиливающий _onChannelClose , который зачем-то уничножает весь пир апри закрытии канала данных
        this.peerConnections[this.remoteUserId]._onChannelClose = () => null;
        // ---------------------------------------------------------------------
        // this.peerConnections[this.remoteUserId]._debug = console.log;
        this.peerConnections[this.remoteUserId].on('error', error => {
            this.log('errorPeerConnectionRemote', error, true);
        });

        this.peerConnections[this.remoteUserId].on('signal', data => {
            if (data?.type === 'offer') {
                this.log('sendReceiveVideoFrom',{remoteUserId, data});
                this.sendRequest('receiveVideoFrom', {
                    sender: remoteUserId,
                    sdpOffer: data.sdp
                }, this.onRemoteVideoOfferSent.bind(null, remoteUserId));
            }
            if (data?.candidate) {
                const dataToSend = {...data.candidate};
                dataToSend.endpointName = this.remoteUserId;
                this.log('sendOnIceCandidateRemote',{remoteUserId, dataToSend});
                this.sendRequest('onIceCandidate', dataToSend, this.onRemoteVideoCandidateSent.bind(null,remoteUserId));
            }
        });
        this.peerConnections[this.remoteUserId].on('stream', stream => {
            this.log('gotRemoteStream',stream);
            this.remoteStream = stream;
            this.showRemoteVideo();
        });
        this.peerConnections[this.remoteUserId].on('iceStateChange', status => {
            this.log('iceStateChangeRemote', status);
            switch (status) {
                case 'failed': {
                    this.remotePlaying = false;
                }
            }
        });
        this.peerConnections[this.remoteUserId].on('close', () => {
            this.log('peerConnectionClosedRemote', status);
            this.remotePlaying = false;
        });
    }

    onIceCandidateReceived = candidate => {
        this.log(`receivedIceCandidate${candidate.endpointName === this.userId ? 'Local' : 'Remote'}`, candidate);
        this.peerConnections[candidate.endpointName]?.signal({candidate});
    }

    onRoomConnected = (error, response) => {
        if (error) {
            this.log('errorJoiningToRoom',{error, response}, true);
            setTimeout(this.connect, 1000);
        } else {
            this.roomConnected = true;
            this.log('joinedToRoom',response);
            this.processRemoteUsers(response.value);
            this.publishLocalVideo();
        }
    };

    onRemotePublished = user => {
        this.log('onRemotePublished', user);
        this.processRemoteUsers([user]);
    };

    onSocketConnected = () => {
        this.log('signalServerConnected');
        this.connect();
    };

    onSocketDisconnected = message => {
        this.log('signalServerDisconnected', message);
        this.roomConnected = false;
    };

    onParticipantEvicted = message => {
        this.log('onParticipantEvicted', message);
        // this.roomConnected = false;
        // this.eventEmitter.emit(kurentoEventsList.room.disconnected, this.getRoomInfo())
    };

    onParticipantJoined = message => {
        this.log('onParticipantJoinend', message);
    };

    onParticipantLeft = userId => {
        this.log('onParticipantEvicted', userId);
        if (this.remoteUserIdKurento === userId) {
            this.remoteUserInRoom = false;
            this.showRemoteVideo(false);
            this.remoteUserIdKurento = null;
            this.peerConnections[this.remoteUserId].destroy();
            this.remoteStream = null;
        }
        // this.roomConnected = false;
        // this.eventEmitter.emit(kurentoEventsList.room.disconnected, this.getRoomInfo())
    };

    onSocketError = error => {
        this.log('signalServerError', error, true);
        this.roomConnected = false;
    };

    getRoomInfo = () => {
        return {
            userId: this.userId, remoteUserId:this.remoteUserId, roomId: this.roomId
        }
    };
    sendRequest = (method, params, callback) =>{
        this.jsonRPCClient.send(method, params, callback);
    };
}

export default KurentoAdapter;