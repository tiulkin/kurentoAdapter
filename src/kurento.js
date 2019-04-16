import Peer from 'simple-peer';
import RpcBuilder from 'kurento-jsonrpc';
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
const tryingTimeToError = 7000;
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

        this.roomServerUrl = config.roomServerUrl;

        this.localVideoParentElement = config.localVideoParentElement;
        this.remoteVideoParentElement = config.remoteVideoParentElement;

        this.remoteStreamOptions = null;
        this.localStream = null;

        this.peerConnections = {};

        this.rtcConstrains = config.rtcConstrains || defaultConstraints;
        this.iceServers = config.iceServers || defaultIceServers;

        this.roomId = config.roomId;
        this.userId = config.userId;
        this.remoteUserId = config.remoteUserId;
        this.remoteUserIdKurento = config.remoteUserIdKurento;

        this.audioOnly = false;

        this.roomConnected = false;
        this.localPublished = false;
        this.remotePlaying = false;

        this.reconnectRoomTime = 0;
        this.reconnectPublishTime = 0;
        this.reconnectReceiveTime = 0;

        this.reconnectInterval = null;

        this.start();
        // the first attempt for audio and video

    }
    start = () => {
        if (this.peerConnections[this.userId]) {
            this.peerConnections[this.userId].destroy();
        }
        if (this.peerConnections[this.remoteUserId]) {
            this.peerConnections[this.remoteUserId].destroy();
        }
        getUserMedia(this.rtcConstrains, (err, stream) => {
            if (err) {
                // the second attempt for audio only
                this.rtcConstrains.video = false;
                getUserMedia(this.rtcConstrains, (err, stream) => {
                    if (err) {
                        this.eventEmitter.emit(kurentoEventsList.access.denied, this.getRoomInfo());
                    } else{
                        this.audioOnly = true;
                        this.initConnection(stream);
                    }
                })
            } else {
                this.initConnection(stream);
            }
        });
    }

    initConnection = stream => {
        this.eventEmitter.emit(kurentoEventsList.access.granted, this.getRoomInfo());
        this.localStream =  stream;
        try {
            this.initJsonRpcClient();
        } catch (error) {
            this.eventEmitter.emit(kurentoEventsList.access.granted, this.getRoomInfo());
            return {
                error: error
            };
        }
        // setTimeout(() => this.reconnectInterval = setInterval(this.reconnectDeamon, 5000), 10000);
    }

    reconnectDeamon = () => {
        if (!this.roomConnected){
            if (this.reconnectRoomTime + tryingTimeToError < new Date().getTime()){
                this.start();
            }
        } else if (!this.localPublished){
            if (this.reconnectPublishTime + tryingTimeToError < new Date().getTime()){
                this.start();
            }
        } else if (!this.remotePlaying){
            if (this.reconnectReceiveTime + tryingTimeToError < new Date().getTime()){
                this.receiveRemoteVideo(this.remoteUserIdKurento);
            }
        }
    }

    initJsonRpcClient = () => {
        const config = {
            heartbeat: 2000,
            sendCloseMessage: false,
            ws: {
                uri: this.roomServerUrl,
                useSockJS: false,
                onconnected: this.onSocketConnected,
                ondisconnect: this.onSocketDisconnected,
                // onreconnecting: this.onSocketReconnecting,
                // onreconnected: this.onSocketReconnected,
                onerror: this.onSocketError
            },
            rpc: {
                requestTimeout: 15000,
                participantJoined: this.onSocketDisconnected,
                participantPublished: this.onRemotePublished,
                participantUnpublished: this.onSocketDisconnected,
                participantLeft: this.onSocketDisconnected,
                participantEvicted: this.onSocketDisconnected,
                iceCandidate: this.onIceCandidateReceived ,
                mediaError: this.onSocketDisconnected,
                sendMessage: this.onSocketDisconnected,
            }
        };
        this.jsonRpcClient =  new RpcBuilder.clients.JsonRpcClient(config);
    }

    showLocalVideo = () => {
        const parentElement = typeof this.localVideoParentElement === 'string'
            ? document.getElementById(this.localVideoParentElement)
            : this.localVideoParentElement;

        if (this.localStream && parentElement) {
            let videoElement = parentElement.getElementsByTagName('video')[0];

            if (videoElement) {
                parentElement.removeChild(videoElement);
            }

            videoElement = document.createElement('video');
            videoElement.autoplay = true;
            videoElement.controls = false;
            videoElement.muted = true;
            videoElement.onplay = () => this.eventEmitter.emit(kurentoEventsList.localVideo.playing, this.getRoomInfo());
            videoElement.onerror = () => this.eventEmitter.emit(kurentoEventsList.localVideo.error, this.getRoomInfo());
            videoElement.srcObject = this.localStream;

            parentElement.appendChild(videoElement);

        }
    };

    showRemoteVideo = stream => {
        const parentElement = typeof this.remoteVideoParentElement === 'string'
            ? document.getElementById(this.remoteVideoParentElement)
            : this.remoteVideoParentElement;

        if (stream && parentElement) {
            let audioElement = parentElement.getElementsByTagName('audio')[0];
            let videoElement = parentElement.getElementsByTagName('video')[0];

            if (audioElement) parentElement.removeChild(audioElement);
            if (videoElement) parentElement.removeChild(videoElement);

            videoElement = document.createElement('video');
            videoElement.autoplay = true;
            videoElement.controls = false;
            audioElement = document.createElement('audio');
            audioElement.autoplay = true;
            audioElement.controls = false;

            videoElement.onplay = () => {
                audioElement.srcObject = null;
                this.remotePlaying = true;
                this.eventEmitter.emit(kurentoEventsList.localVideo.playing, this.getRoomInfo());
            };
            videoElement.onerror = () => {
                this.remotePlaying = false;
                this.eventEmitter.emit(kurentoEventsList.localVideo.error, this.getRoomInfo());
            };
            audioElement.onplay = () => {
                audioElement.srcObject = null;
                this.remotePlaying = true;
                this.eventEmitter.emit(kurentoEventsList.localVideo.playing, this.getRoomInfo());
            };
            audioElement.onerror = () => {
                this.remotePlaying = false;
                this.eventEmitter.emit(kurentoEventsList.localVideo.error, this.getRoomInfo());
            };

            audioElement.srcObject = stream;
            videoElement.srcObject = stream;

            parentElement.appendChild(videoElement);
            parentElement.appendChild(audioElement);
        }
    };

    processRemoteUsers = users => {
        const members = users || [];
        let remoteUserId = null;

        members.forEach (member => {
            if ((member.id||'').includes(this.remoteUserId) && member.streams.length)
                remoteUserId = `${member.id}_${member.streams[member.streams.length-1].id}`;
        });
        this.eventEmitter.emit(kurentoEventsList.room.connected, this.getRoomInfo());
        this.eventEmitter.emit(kurentoEventsList.log.record, this.getRoomInfo());

        if (remoteUserId){
            this.remoteUserIdKurento = remoteUserId;
            this.receiveRemoteVideo(remoteUserId);
        }
    }

    onLocalVideoOfferSent = (error, response) => {
        if(error) {
            this.eventEmitter.emit(kurentoEventsList.signaling.offerError, this.getRoomInfo());
        } else {
            this.eventEmitter.emit(kurentoEventsList.signaling.offerSent, this.getRoomInfo());
            this.peerConnections[this.userId].signal({
                type: 'answer',
                sdp: response.sdpAnswer
            })

        }
    };

    onRemoteVideoOfferSent = (remoteUserId, error, response) => {
        if(error) {
            this.eventEmitter.emit(kurentoEventsList.signaling.offerError, this.getRoomInfo());
        } else {
            this.eventEmitter.emit(kurentoEventsList.signaling.offerSent, this.getRoomInfo());
            this.peerConnections[this.remoteUserId].signal({
                type: 'answer',
                sdp: response.sdpAnswer
            })

        }
    };

    onLocalVideoCandidateSent = (error, response) => {
        if(error) {
            this.eventEmitter.emit(kurentoEventsList.signaling.localCandidateSendError, this.getRoomInfo());
        } else {
            this.eventEmitter.emit(kurentoEventsList.signaling.localCandidateSent, this.getRoomInfo());
        }
    };

    onRemoteVideoCandidateSent = (remoteUserId, error, response) => {
        if(error) {
            this.eventEmitter.emit(kurentoEventsList.signaling.localCandidateSendError, this.getRoomInfo());
        } else {
            this.eventEmitter.emit(kurentoEventsList.signaling.localCandidateSent, this.getRoomInfo());
        }
    };

    publishLocalVideo = () => {
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
        this.peerConnections[this.userId].on('error', function (err) {
            console.log('error', err)
        });

        this.peerConnections[this.userId].on('signal', data => {
            if (data?.type === 'offer') {
                this.sendRequest('publishVideo', {
                    sdpOffer: data.sdp,
                    doLoopback: false
                }, this.onLocalVideoOfferSent);
                this.eventEmitter.emit(kurentoEventsList.signaling.offerSending, this.getRoomInfo());
            }
            if (data?.candidate) {
                const dataToSend = {...data.candidate};
                dataToSend.endpointName = this.userId;
                this.sendRequest('onIceCandidate', dataToSend, this.onLocalVideoCandidateSent);
                this.eventEmitter.emit(kurentoEventsList.signaling.candidateSending, this.getRoomInfo());
            }
        });
        this.showLocalVideo();

        this.peerConnections[this.userId].on('iceStateChange', status => {
            console.log('iceStateChange', status);
            switch (status) {
                case 'connected': {
                    this.localPublished = true;
                    break;
                }
                case 'failed': {
                    this.localPublished = false;
                    this.reconnectPublishTime = new Date().getTime();
                }

            }
        });
        this.peerConnections[this.userId].on('close', function () {
            this.localPublished = false;
            this.reconnectPublishTime = new Date().getTime();
        });
    };

    receiveRemoteVideo = (remoteUserId) => {
        if (this.peerConnections[this.remoteUserId]) {
            const oldPeerConnection = this.peerConnections[this.remoteUserId];

            oldPeerConnection.destroy();
        }

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
        //this.peerConnections[this.remoteUserId]._debug = console.log;
        this.peerConnections[this.remoteUserId].on('error', function (err) {
            console.log('error', err)
        });

        this.peerConnections[this.remoteUserId].on('signal', data => {
            if (data?.type === 'offer') {
                this.sendRequest('receiveVideoFrom', {
                    sender: remoteUserId,
                    sdpOffer: data.sdp
                }, this.onRemoteVideoOfferSent.bind(null, remoteUserId));
                this.eventEmitter.emit(kurentoEventsList.signaling.offerSending, this.getRoomInfo());
            }
            if (data?.candidate) {
                const dataToSend = {...data.candidate};
                dataToSend.endpointName = this.remoteUserId;
                this.sendRequest('onIceCandidate', dataToSend, this.onRemoteVideoCandidateSent.bind(null,remoteUserId));
                this.eventEmitter.emit(kurentoEventsList.signaling.candidateSending, this.getRoomInfo());
            }
        });
        this.peerConnections[this.remoteUserId].on('stream', stream => {
            this.showRemoteVideo(stream)
        });
        this.peerConnections[this.remoteUserId].on('iceStateChange', status => {
            switch (status) {
                case 'failed': {
                    this.remotePlaying = false;
                    this.reconnectReceiveTime = new Date().getTime();
                }
            }
        });
        this.peerConnections[this.remoteUserId].on('close', function () {
            this.remotePlaying = false;
            this.reconnectReceiveTime = new Date().getTime();
        });
    }
    connect = () => {
        try {
            this.sendRequest('joinRoom', {user: this.userId, room: this.roomId}, this.onRoomConnected)
        } catch (e) {
            setTimeout( this.connect, 1000);
        }
    };

    onIceCandidateReceived = candidate => {
        this.peerConnections[candidate.endpointName]?.signal({candidate});
    }

    onRoomConnected = (error, response) => {
        if (error) {
            console.log('trying again', error, response);
            setTimeout( this.connect, 1000);
            this.eventEmitter.emit(kurentoEventsList.room.connectError, { ...this.getRoomInfo(), error })
        } else {
            this.processRemoteUsers(response.value);
            this.publishLocalVideo();
        }
    };

    onRemotePublished = user => {
        console.log('new user', user);
        this.processRemoteUsers([user]);
    };

    onSocketConnected = error => {
        console.log('connected', error);
        this.connect();
        this.roomConnected = true;
        this.eventEmitter.emit(kurentoEventsList.room.connected, this.getRoomInfo())
    };

    onSocketDisconnected = error => {
        this.roomConnected = false;
        this.reconnectRoomTime = new Date().getTime();
        this.eventEmitter.emit(kurentoEventsList.room.disconnected, this.getRoomInfo())
    };

    onSocketError = error => {
        this.roomConnected = false;
        this.reconnectRoomTime = false;
        this.eventEmitter.emit(kurentoEventsList.room.reconnecting, this.getRoomInfo())
    };
    //
    // onSocketReconnected = error => {
    //     console.log('onSocketReconnected ', error);
    //     this.eventEmitter.emit(kurentoEventsList.room.reconnected, this.getRoomInfo())
    // };

    // onSocketReconnected = error => {
    //     console.log('onSocketError ', error);
    //     this.eventEmitter.emit(kurentoEventsList.room.reconnected, this.getRoomInfo())
    // };

    getRoomInfo = () => {

    };

    sendRequest = (method, params, callback) =>{
        this.jsonRpcClient.send(method, params, callback);
    };
}

export default KurentoAdapter;