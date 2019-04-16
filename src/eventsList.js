const kurentoEventsList = {
    room: {
        connected: Symbol(),
        disconnected: Symbol(),
        reconnecting: Symbol(),
        reconnected: Symbol(),
        connectError: Symbol()
    },
    signaling: {
        offerSending: Symbol(),
        offerSent: Symbol(),
        offerError: Symbol()
    },
    access: {
        connected: Symbol(),
        disconnected: Symbol(),
    },
    localVideo: {
        playing: Symbol(),
        error: Symbol(),
    },
    log: {
        record: Symbol()
    }
};

export default kurentoEventsList;
