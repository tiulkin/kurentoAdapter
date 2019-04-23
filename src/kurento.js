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
const tryingTimeToError = 5000;
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

        this.audioOnly = false;

        this.localVideoDisabled = config.localVideoDisabled;
        this.localAudioDisabled = config.localAudioDisabled;
        this.remoteVideoDisabled = config.remoteVideoDisabled;
        this.remoteAudioDisabled = config.remoteAudioDisabled;

        this.connectionState = {
            signalServerState: null,
            roomConnectionState: null,
            localVideoState: null,
            remoteVideoState: null,
            remoteUserInRoom: false,
            remoteVideoPlaying: false,
            remoteUserInRoomId: null,
            remoteUserInRoomStreamId: null
        };
        this.remotePlaying = false;

        this.nextGeneralStateCheck  = 0;
        this.nextStateCheck = {};

        this.start();
        // the first attempt for audio and video

    }
    log = (event, data, isError) => {
        if (this.logEventName) this.emit(this.logEventName, {event, data, isError});
    };

    emit = (event, data) => {
        console.log(event, data);
        this.eventEmitter.emit(event, { data, context:this.getRoomInfo() });
    };

    start = () => {
        this.log('startingProcess');

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
        if (this.connectionState.roomConnectionState === 'connecting') return;
        this.changeStates({
            signalServerState: 'connecting',
            roomConnectionState: null
        });
        this.localStream =  stream || this.localStream;
        this.log('gotLocalStream');
        try {
            this.log('initJsonRPCClient');
            if (this.jsonRPCClient) {
                try {
                    this.log('closingExistedJsonRPCClient');
                    this.jsonRPCClient.close();
                } catch (error) {
                    this.log('errorClosingExistedJsonRPCClient', error, true);
                }
            }
            this.initJsonRPCClient();
        } catch (error) {
            this.log('initJsonRPCClientError', error, true);
        }
    };

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
        if (this.connectionState.roomConnectionState === 'connecting') return;
        this.log('roomConnectionState', 'connecting');
        try {
            this.changeStates({roomConnectionState: 'connecting'});
            this.sendRequest('joinRoom', {user: this.userId, room: this.roomId}, this.onRoomConnected)
        } catch (e) {
            this.changeStates({roomConnectionState: 'disconnected'});
            this.log('errorJoiningToRoom', e, true);
        }
    };

    processStateChanges = () => {
        // для упрощения реадлизации считаем, что блокирующие других проверки
        // находятся в начале массива в порядке приоритета
        console.log(this.connectionState);
        let stopChecking = false;

        this.stateMachine.forEach(condition => {
                let passed = 0;
                const logData = {};

                if(stopChecking) return;
                Object.keys(condition.states).forEach(state => {
                    if (condition.states[state].includes(this.connectionState[state])) {
                        logData[state] = this.connectionState[state];
                        passed += 1;
                    }
                });
                console.log(passed);
                if (passed === Object.keys(condition.states).length) {
                    this.log('stateMachine', {method: condition.startMethod, data: logData});
                    setTimeout(this[condition.startMethod], condition.delay);
                    if (condition.blocksOthers) {
                        stopChecking = true;
                    }
                }
            }
        )
    };

    closeLocalConnection = () => {
        this.log('closeLocalConnection');
        this.peerConnections[this.userId].destroy();
        this.peerConnections=null;
    };

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

        this.changeStates({'remoteVideoPlaying': false});
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
                // audioElement.srcObject = null;
                this.changeStates({'remoteVideoPlaying': true});
                this.log('remoteVideoStarted');
            };
            videoElement.onerror = () => {
                this.log('remoteVideoError');
                this.changeStates({'remoteVideoPlaying': false});
            };
            audioElement.onplay = () => {
                this.log('remoteAudioStarted');
                // videoElement.srcObject = null;
                this.changeStates({'remoteVideoPlaying': true});
            };
            audioElement.onerror = () => {
                this.changeStates({'remoteVideoPlaying': false});
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
    };

    processRemoteUsers = users => {
        const members = users || [];
        let remoteUserInRoomId = null;
        let remoteUserInRoomStreamId = null;

        members.forEach (member => {
            if ((member.id||'').includes(this.remoteUserId) && member.streams?.length) {
                remoteUserInRoomId = member.id;
                remoteUserInRoomStreamId = member.streams[member.streams.length-1].id;
            }
        });

        if (remoteUserInRoomId) {
            this.changeStates({
                remoteUserInRoom: true,
                remoteUserInRoomId,
                remoteUserInRoomStreamId
            });
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

    onLocalVideoCandidateSent = (error, response) => {
        if(error) {
            this.log('errorSendingIceCandidateLocal', {error, response}, true);
        }
    };

    onRemoteVideoCandidateSent = (remoteUserId, error, response) => {
        if(error) {
            this.log('errorSendingIceCandidateRemote', {error, response}, true);
        }
    };

    publishLocalVideo = () => {
        this.log('createPeerConnectionLocal');
        if(this.connectionState.localVideoState==='peerConnectionConnecting') return;
        this.peerConnections[this.userId] = new Peer({
            initiator: true,
            trickle: true,
            allowHalfTrickle: true,
            stream: this.localStream,
            config: { iceServers: this.iceServers},
            iceCompleteTimeout: 10000,
            offerOptions: {
                offerToReceiveAudio: false,
                offerToReceiveVideo: false,
                offerToSendAudio: true,
                offerToSendVideo: !this.audioOnly
            }
        });
        this.changeStates({localVideoState:'peerConnectionConnecting'});
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
                    this.changeStates({localVideoState:'peerConnectionConnected'});
                    break;
                }
                case 'disconnected': {
                    this.changeStates({localVideoState:'peerConnectionDisconnected'});
                    break;
                }
                case 'failed': {
                    this.changeStates({localVideoState:'peerConnectionFailed'});
                    break;
                }
            }
        });

        this.peerConnections[this.userId].on('close', () => {
            this.log('peerConnectionClosedLocal', status);
            this.changeStates({localVideoState:'peerConnectionDisconnected'});
        });
    };

    republishLocalVideo = () => this.initConnection;


    receiveRemoteVideo = () => {
        if (this.connectionState.remoteVideoState === 'peerConnectionConnecting') return;
        this.changeStates({remoteVideoState :'peerConnectionConnecting'});
        if (this.peerConnections[this.remoteUserId]) {
            this.log('destroyingOldPeerConnectionRemote');
            this.peerConnections[this.remoteUserId].destroy();
            this.showRemoteVideo(true);
        }
        this.log('createPeerConnectionRemote', this.connectionState.remoteUserInRoomId);
        this.peerConnections[this.remoteUserId] = new Peer({
            initiator: true,
            trickle: true,
            allowHalfTrickle: true,
            iceCompleteTimeout: 10000,
            offerOptions: {
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
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
                this.log('sendReceiveVideoFrom',{remoteUserId: this.connectionState.remoteUserInRoomId, data});
                this.sendRequest('receiveVideoFrom', {
                    sender: `${this.connectionState.remoteUserInRoomId}_${this.connectionState.remoteUserInRoomStreamId}`,
                    sdpOffer: data.sdp
                }, this.onRemoteVideoOfferSent.bind(null, this.connectionState.remoteUserInRoomId));
            }
            if (data?.candidate) {
                const dataToSend = {...data.candidate};
                dataToSend.endpointName = this.remoteUserId;
                this.log('sendOnIceCandidateRemote',{remoteUserId: this.connectionState.remoteUserInRoomId, dataToSend});
                this.sendRequest('onIceCandidate', dataToSend, this.onRemoteVideoCandidateSent.bind(null, this.connectionState.remoteUserInRoomId));
            }
        });

        this.peerConnections[this.remoteUserId].on('stream', stream => {
            this.log('gotRemoteStream');
            this.remoteStream = stream;
            this.showRemoteVideo();
        });

        this.peerConnections[this.remoteUserId].on('iceStateChange', status => {
            this.log('iceStateChangeRemote', status);
            switch (status) {
                case 'connected': {
                    this.changeStates({remoteVideoState:'peerConnectionConnected'});
                    break;
                }
                case 'disconnected': {
                    this.changeStates({remoteVideoState:'peerConnectionDisconnected'});
                    break;
                }
            }
        });

        this.peerConnections[this.remoteUserId].on('close', () => {
            this.log('peerConnectionClosedRemote', status);
            this.changeStates({remoteVideoState:'peerConnectionFailed'});
        });
    };

    onIceCandidateReceived = candidate => {
        this.log(`receivedIceCandidate${candidate.endpointName === this.userId ? 'Local' : 'Remote'}`, candidate);
        this.peerConnections[candidate.endpointName]?.signal({candidate});
    };

    onRoomConnected = (error, response) => {
        if (error) {
            this.changeStates({
                roomConnectionState: 'disconnected',
            });
            this.log('errorJoiningToRoom',{error, response}, true);
        } else {
            this.changeStates({
                remoteUserInRoom: false,
                roomConnectionState: 'connected',
                remoteUserInRoomId: null,
                remoteUserInRoomStreamId: null,
                localVideoState: null,
                remoteVideoState: null
            });
            this.log('joinedToRoom',response);
            this.processRemoteUsers(response.value);
        }
    };

    onRemotePublished = user => {
        this.log('onRemotePublished', user);
        this.processRemoteUsers([user]);
    };

    onSocketConnected = () => {
        this.log('signalServerConnected');
        this.changeStates({signalServerState: 'connected' });
    };

    onSocketDisconnected = message => {
        this.log('signalServerDisconnected', message);
        this.changeStates({signalServerState: 'disconnected' });
    };

    onParticipantEvicted = data => {
        this.log('onParticipantEvicted', data);
        if (this.connectionState.remoteUserInRoomId === data?.name) {
            this.changeStates({
                remoteUserInRoom: false,
                remoteUserInRoomId: null,
                remoteUserInRoomStreamId: null
            });
            this.showRemoteVideo(false);
            this.peerConnections[this.remoteUserId]?.destroy();
            this.remoteStream = null;
        }
    };

    onParticipantJoined = message => {
        this.log('onParticipantJoinend', message);
    };

    onParticipantLeft = data => {
        this.log('onParticipantLeft', this.connectionState.remoteUserInRoomId, data);
        if (this.connectionState.remoteUserInRoomId === data?.name) {
            this.changeStates({
                remoteUserInRoom: false,
                remoteUserInRoomId: null,
                remoteUserInRoomStreamId: null
            });
            this.showRemoteVideo(true);
            this.peerConnections[this.remoteUserId]?.destroy();
            this.remoteStream = null;
        }
    };

    onSocketError = error => {
        this.log('signalServerError', null, true);
        this.changeStates({signalServerState: 'disconnected' });
    };

    getRoomInfo = () => {
        return {
            userId: this.userId, remoteUserId:this.remoteUserId, roomId: this.roomId
        }
    };

    sendRequest = (method, params, callback) =>{
        this.jsonRPCClient.send(method, params, callback);
    };

    changeStates = changes => {
        this.connectionState = { ...this.connectionState, ...changes};
        this.processStateChanges();
    };

    stateMachine = [
        {
            states: {
                signalServerState: [null],
                roomConnectionState: [null, 'connecting', 'connected', 'disconnected'],
                localVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteUserInRoom: [true, false],
                remoteVideoPlaying: [true, false]
            },
            startMethod: 'initConnection',
            delay: 0,
            blocksOthers: true,
        },
        {
            states: {
                signalServerState: ['disconnected'],
                roomConnectionState: [null, 'connecting', 'connected', 'disconnected'],
                localVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteUserInRoom: [true, false],
                remoteVideoPlaying: [true, false]
            },
            startMethod: 'initConnection',
            delay: 1000,
            blocksOthers: true,
        },
        {
            states: {
                signalServerState: ['connected'],
                roomConnectionState: [null],
                localVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteUserInRoom: [true, false],
                remoteVideoPlaying: [true, false]
            },
            startMethod: 'connect',
            delay: 0,
            blocksOthers: true,
        },
        {
            states: {
                signalServerState: ['connected'],
                roomConnectionState: ['disconnected'],
                localVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteUserInRoom: [true, false],
                remoteVideoPlaying: [true, false]
            },
            startMethod: 'connect',
            delay: 1000,
            blocksOthers: true,
        },
        {
            states: {
                signalServerState: ['connected'],
                roomConnectionState: ['connected'],
                localVideoState: [null],
                remoteVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteUserInRoom: [true, false],
                remoteVideoPlaying: [true, false]
            },
            startMethod: 'publishLocalVideo',
            delay: 0,
            blocksOthers: false,
        },
        {
            states: {
                signalServerState: ['connected'],
                roomConnectionState: ['connected'],
                localVideoState: ['peerConnectionDisconnected', 'peerConnectionFailed'],
                remoteVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteUserInRoom: [true, false],
                remoteVideoPlaying: [true, false]
            },
            startMethod: 'republishLocalVideo',
            delay: 1000,
            blocksOthers: false,
        },
        {
            states: {
                signalServerState: ['connected'],
                roomConnectionState: ['connected'],
                localVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteVideoState: [null, 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteUserInRoom: [true],
                remoteVideoPlaying: [true, false]
            },
            startMethod: 'receiveRemoteVideo',
            delay: 0,
            blocksOthers: false,
        },
        {
            states: {
                signalServerState: ['connected'],
                roomConnectionState: ['connected'],
                localVideoState: [null, 'peerConnectionConnecting', 'peerConnectionConnected', 'peerConnectionFailed', 'peerConnectionDisconnected'],
                remoteVideoState: ['peerConnectionConnected'],
                remoteUserInRoom: [true],
                remoteVideoPlaying: [false]
            },
            startMethod: 'showRemoteVideo',
            delay: 0,
            blocksOthers: false,
        }
    ];
}

export default KurentoAdapter;