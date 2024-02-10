// TODO: reimplement VM variable/list access: see old version https://github.com/MikeDev101/cloudlink-omega/blob/bde3426ce537c6adae0ca3da3d47db7473513902/client/cloudlinkomega_turbowarp.js

(function (Scratch) {
    // Modify to point to server. (Set as localhost for testing)
    const rootApiURL = "https://omega.mikedev101.cc"
    const rootWsURL = "wss://omega.mikedev101.cc"

    // Define class to provide message encryption (ECDH-P256-AES-GCM with SPKI-BASE64 public keys)
    class OmegaEncryption {
        constructor() {
            this.secrets = new Map(); // Store derived key secrets
            this.keyPair = null; // ECDH P-256 key pair (public: spki, private: pkcs8)
        }
    
        async generateKeyPair() {
            if (this.keyPair) {
                reject("Key pair already exists");
                return;
            }
            this.keyPair = await window.crypto.subtle.generateKey(
                {
                    name: "ECDH",
                    namedCurve: "P-256"
                },
                true,
                ["deriveKey", "deriveBits"]
            );
            return this.keyPair;
        }
    
        async exportPublicKey() {
            // Export this.keyPair.publicKey
            if (!this.keyPair) {
                reject("Key pair does not exist");
                return;
            }
            let exportedKey = await window.crypto.subtle.exportKey("spki", this.keyPair.publicKey);
            return this.arrayBufferToBase64(new Uint8Array(exportedKey));
        }
    
        async importPublicKey(exportedKey) {
            const exportedKeyArray = this.base64ToArrayBuffer(exportedKey);
            const publicKey = await window.crypto.subtle.importKey(
                "spki",
                exportedKeyArray,
                {
                    name: "ECDH",
                    namedCurve: "P-256"
                },
                true,
                []
            );
            return publicKey;
        }
    
        async deriveSharedKey(publicKey, privateKey) {
            const sharedKey = await window.crypto.subtle.deriveKey(
                {
                    name: "ECDH",
                    public: publicKey
                },
                privateKey,
                {
                    name: "AES-GCM",
                    length: 256
                },
                true,
                ["encrypt", "decrypt"]
            );
            return sharedKey;
        }
    
        async encryptMessage(message, sharedKey) {
            const encodedMessage = new TextEncoder().encode(message);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encryptedMessage = await window.crypto.subtle.encrypt(
                {
                    name: "AES-GCM",
                    iv: iv
                },
                sharedKey,
                encodedMessage
            );
            const encryptedMessageArray = new Uint8Array(encryptedMessage);
            const encryptedMessageBase64 = this.arrayBufferToBase64(encryptedMessageArray);
            const ivBase64 = this.arrayBufferToBase64(iv);
            return { encryptedMessage: encryptedMessageBase64, iv: ivBase64 };
        }
    
        async decryptMessage(encryptedMessageBase64, ivBase64, sharedKey) {
            const encryptedMessageArray = this.base64ToArrayBuffer(encryptedMessageBase64);
            const iv = this.base64ToArrayBuffer(ivBase64);
            const decryptedMessage = await window.crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: iv
                },
                sharedKey,
                encryptedMessageArray
            );
            const decodedMessage = new TextDecoder().decode(decryptedMessage);
            return decodedMessage;
        }
    
        arrayBufferToBase64(buffer) {
            let binary = '';
            let bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        }
    
        base64ToArrayBuffer(base64) {
            let binary_string = window.atob(base64);
            let len = binary_string.length;
            let bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binary_string.charCodeAt(i);
            }
            return bytes.buffer;
        }

        setSharedKey(remotePeerId, sharedKey) {
            this.secrets.set(remotePeerId, sharedKey);
        }

        getSharedKey(remotePeerId) {
            return this.secrets.get(remotePeerId);
        }

        setSharedKeyFromPublicKey(remotePeerId, publicKey) {
            return new Promise((resolve, reject) => {
                // Convert to shared secret
                this.importPublicKey(publicKey)
                .then((pKey) => {
                    this.deriveSharedKey(pKey, this.keyPair.privateKey)
                    .then((sharedKey) => {
                        this.setSharedKey(remotePeerId, sharedKey);
                        resolve();
                    })
                    .catch((error) => {
                        console.error(`Error deriving shared key for ${remotePeerId}: ${error}`);
                        reject();
                    });
                })
                .catch((error) => {
                    console.error(`Error importing public key for ${remotePeerId}: ${error}`);
                    reject();
                });
            });
        }
    }
    
    // Define class for authentication
    class OmegaAuth {
        constructor() {
            this.loginUrl = `${rootApiURL}/api/v0/login`;
            this.registerUrl = `${rootApiURL}/api/v0/register`;
            this.registerSuccess = false;
            this.loginSuccess = false;
            this.sessionToken = new String();
        }

        async Login(email, password) {
            try {
                const response = await fetch(this.loginUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email,
                        password,
                    }),
                });

                const data = await response.text(); // text/plain response. Should be just "OK".
                if (response.ok) {
                    console.log("Account logged in successfully.");
                    this.sessionToken = data;

                } else {
                    console.warn("Account login failed:", data);
                }
                this.loginSuccess = response.ok;
            } catch (error) {
                console.error('Error getting login token:', error);
            }
        }

        async Register(email, username, password) {
            try {
                const response = await fetch(this.registerUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email,
                        username,
                        password,
                    }),
                });

                const data = await response.text(); // text/plain response. Should be just "OK".
                if (data == 'OK') {
                    console.log("Account registered successfully.");
                    
                } else {
                    console.warn("Account registration failed:", data);
                }
                this.registerSuccess = (data == 'OK');
            } catch (error) {
                console.error('Error getting response:', error);
                this.registerSuccess = false;
            }
        }
    }

    class OmegaRTC {
        constructor() {
            this.configuration = {
                // Public STUN/TURN servers.
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' }, // Unencrypted STUN
                    { urls: 'stun:freeturn.net:3478' }, // Unencrypted UDP/TCP STUN
                    { urls: 'stun:freeturn.net:5349' }, // Unencrypted TCP/TLS STUN
                    { urls: 'turn:freeturn.net:3478', username: "free", credential: "free" }, // Unencrypted UDP/TCP TURN
                    { urls: 'turns:freeturn.net:5349', username: "free", credential: "free" }, // Encrypted TLS TURN
                ]
            }
            this.peerConnections = new Map();
            this.voiceConnections = new Map();
            this.dataChannels = new Map();
            this.messageHandlers = {
                onIceCandidate: {},
                onIceGatheringDone: {},
                onChannelOpen: {},
                onChannelMessage: {},
            }
            this.iceCandidates = {};
        }

        getPeers() {
            let output = new Object();

            // Convert each entry of peerConnections into [{name: ulid}] format
            let peers = Array.from(this.peerConnections.keys());
            let cons = this.peerConnections;

            // Only include peer connections that are fully established.
            Array.from(peers).forEach((ulid) => {
                if (cons.get(ulid).connectionState == "connected") output[cons.get(ulid).user] = ulid;
            })

            return output;
        }

        getPeerChannels(remoteUserId) {
            if (!this.doesPeerExist(remoteUserId)) return [];
            return Array.from(this.dataChannels.get(remoteUserId).keys());
        }

        // Voice channel functions - Untested.

        async createVoiceOffer(remoteUserId, remoteUserName) {
            const voiceConnection = this.createConnection(remoteUserId, remoteUserName, true);
            this.handleVoiceStream(voiceConnection, remoteUserId, remoteUserName);
            try {
                const offer = await voiceConnection.createOffer();
                await voiceConnection.setLocalDescription(offer);
                return { offer, dataChannel };
            } catch (error) {
                console.error(`Error creating voice offer for ${voiceConnection.user} (${remoteUserId}): ${error}`);
                return null;
            }
        }

        async createVoiceAnswer(remoteUserId, remoteUserName) {
            const voiceConnection = this.createConnection(remoteUserId, remoteUserName, true);
            await this.handleVoiceStream(voiceConnection, remoteUserId, remoteUserName);
            try {
                await voiceConnection.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await voiceConnection.createAnswer();
                await voiceConnection.setLocalDescription(answer);
                return answer;
            } catch (error) {
                console.error(`Error creating voice answer for ${voiceConnection.user} (${remoteUserId}): ${error}`);
                return null;
            }
        }

        async handleVoiceAnswer(remoteUserId, answer) {
            const voiceConnection = this.voiceConnections.get(remoteUserId);
            if (voiceConnection) {
                try {
                    await voiceConnection.setRemoteDescription(new RTCSessionDescription(answer));
                } catch (error) {
                    console.error(`Error handling voice answer for ${voiceConnection.user} (${remoteUserId}): ${error}`);
                }
            } else {
                console.error(`Peer voice connection not found for ${remoteUserId}`);
            }
        }

        addVoiceIceCandidate(remoteUserId, iceCandidate) {
            const voiceConnection = this.voiceConnections.get(remoteUserId);
            if (voiceConnection) {
                try {
                    const candidate = new RTCIceCandidate(iceCandidate);
                    voiceConnection.addIceCandidate(candidate);
                } catch (error) {
                    console.error(`Error adding voice ice candidate for ${voiceConnection.user} (${remoteUserId}): ${error}`);
                }
            } else {
                console.error(`Peer voice connection not found for ${remoteUserId}`);
            }
        }
        
        // Data channel functions - Tested, working.
        
        async createDataOffer(remoteUserId, remoteUserName) {
            const peerConnection = this.createConnection(remoteUserId, remoteUserName);
            this.createDefaultChannel(peerConnection, remoteUserId, remoteUserName);
            try {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                return offer;
            } catch (error) {
                console.error(`Error creating offer for ${peerConnection.user} (${remoteUserId}): ${error}`);
                return null;
            }
        }
    
        async createDataAnswer(remoteUserId, remoteUserName, offer) {
            const peerConnection = this.createConnection(remoteUserId, remoteUserName, false);
            this.createDefaultChannel(peerConnection, remoteUserId, remoteUserName);
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                return answer;
            } catch (error) {
                console.error(`Error creating answer for ${peerConnection.user} (${remoteUserId}): ${error}`);
                return null;
            }
        }
    
        async handleDataAnswer(remoteUserId, answer) {
            const peerConnection = this.peerConnections.get(remoteUserId);
            if (peerConnection) {
                try {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                } catch (error) {
                    console.error(`Error handling answer for ${peerConnection.user} (${remoteUserId}): ${error}`);
                }
            } else {
                console.error(`Peer connection not found for ${remoteUserId}`);
            }
        }
    
        addDataIceCandidate(remoteUserId, iceCandidate) {
            const peerConnection = this.peerConnections.get(remoteUserId);
            if (peerConnection) {
                try {
                    const candidate = new RTCIceCandidate(iceCandidate);
                    peerConnection.addIceCandidate(candidate);
                } catch (error) {
                    console.error(`Error adding ice candidate for ${peerConnection.user} (${remoteUserId}): ${error}`);
                }
            } else {
                console.error(`Peer connection not found for ${peerConnection.user} (${remoteUserId})`);
            }
        }

        // Common function for creating peer/voice connections
        createConnection(remoteUserId, remoteUserName, isAudioOnly) {
            const conn = new RTCPeerConnection(this.configuration);

            // Set username
            conn.user = remoteUserName;

            // Add channel ID counter
            conn.channelIdCounter = 0;

            // Add flag to check if the peer has sent a public key
            conn.hasPublicKey = false;

            // Handle ICE candidate gathering
            conn.onicecandidate = (event) => {
                if (event.candidate) {
                    if (!this.iceCandidates[remoteUserId]) {
                        this.iceCandidates[remoteUserId] = [];
                    }
                    this.iceCandidates[remoteUserId].push(event.candidate);
                    if (this.messageHandlers.onIceCandidate[remoteUserId]) {
                        this.messageHandlers.onIceCandidate[remoteUserId](event.candidate);
                    }
                }
                if (event.target.iceGatheringState === 'complete') {
                    if (this.messageHandlers.onIceGatheringDone[remoteUserId]) {
                        this.messageHandlers.onIceGatheringDone[remoteUserId]();
                    }
                }
            };
            
            // handle data channel creation
            if (!isAudioOnly) {
                conn.ondatachannel = (event) => {
                    const dataChannel = event.channel;
                    this.handleDataChannel(dataChannel, remoteUserId, remoteUserName);
                };
            }
            
            // Handle connection state changes
            conn.onconnectionstatechange = () => {
                switch (conn.connectionState) {
                    case "new":
                        console.log(`Peer ${remoteUserName} (${remoteUserId}) created.`);
                        break;
                    case "connecting":
                        console.log(`Peer ${remoteUserName} (${remoteUserId}) connecting...`);
                        break;
                    case "connected":
                        console.log(`Peer ${remoteUserName} (${remoteUserId}) connected.`);
                        break;
                    case "disconnected":
                        console.log(`Peer ${remoteUserName} (${remoteUserId}) disconnecting...`);
                        break;
                    case "closed":
                        console.log(`Peer ${remoteUserName} (${remoteUserId}) disconnected.`);
                        if (!isAudioOnly) this.disconnectDataPeer(remoteUserId);
                        break;
                    case "failed":
                        console.log(`Peer ${remoteUserName} (${remoteUserId}) connection failed.`);
                        if (!isAudioOnly) this.disconnectDataPeer(remoteUserId);
                        break;
                    default:
                        console.log(`Peer ${remoteUserName} (${remoteUserId}) connection state unknown.`);
                        break;
                }
            };

            if (isAudioOnly) {
                // Handle incoming tracks
                conn.ontrack = (event) => {
                    console.log(`Adding peer ${remoteUserId} audio stream...`);

                    // Auto-play the received audio stream
                    let audioElement = document.createElement(`audio_${remoteUserId}`);
                    audioElement.id = `audio_${remoteUserId}`;
                    audioElement.srcObject = event.streams[0];
                    audioElement.autoplay = true;

                    // Optional: Attach audio element to DOM for remote playback
                    document.body.appendChild(audioElement);
                };
            }
            
            if (isAudioOnly) this.voiceConnections.set(remoteUserId, conn);
            else this.peerConnections.set(remoteUserId, conn);
    
            return conn;
        }
    
        handleDataChannel(dataChannel, remoteUserId, remoteUserName) {
            const channel = dataChannel;

            // Create reference to channel
            if (!this.dataChannels.has(remoteUserId)) this.dataChannels.set(remoteUserId, new Map());

            // Create channel message storage
            channel.dataStorage = new Map();

            channel.onmessage = (event) => {
                if (this.messageHandlers.onChannelMessage[remoteUserId]) {
                    this.messageHandlers.onChannelMessage[remoteUserId](event.data, channel);
                }
            };

            channel.onopen = () => {
                console.log(`Data channel ${channel.label} with ${remoteUserName} (${remoteUserId}) opened`);
                if (this.messageHandlers.onChannelOpen[remoteUserId]) {
                    this.messageHandlers.onChannelOpen[remoteUserId](channel.label);
                }
            };

            channel.onclose = () => {
                console.log(`Data channel ${channel.label} with ${remoteUserName} (${remoteUserId}) closed`);
                if (channel.label == "default") {
                    this.disconnectDataPeer(remoteUserId);
                } else {
                    this.dataChannels.get(remoteUserId).delete(channel.label);
                }
            };
            
            // Store reference to channel
            this.dataChannels.get(remoteUserId).set(channel.label, channel);
        }

        handleVoiceStream(voiceConnection, remoteUserId, remoteUserName) {
            // Create a new audio track
            console.log(`Preparing to open voice stream channel with ${remoteUserName} (${remoteUserId})...`);

            navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                stream.getTracks().forEach(track => {
                    console.log("Adding track:", track, `to peer ${remoteUserName} (${remoteUserId})...`);
                    voiceConnection.addTrack(track, stream);
                });
                console.log(`Opened voice stream channel with ${remoteUserName} (${remoteUserId}).`);
            })
            .catch(err => {
                console.error(`Error adding audio stream for peer ${remoteUserName} (${remoteUserId}):`, err);
            });
        }

        closeVoiceStream(remoteUserId) {
            let audioElement = document.getElementById(`audio_${remoteUserId}`);
            if (audioElement) {
                console.log(`Removing peer ${remoteUserId} audio stream...`);
                document.body.removeChild(audioElement);
            }
        }
    
        createChannel(remoteUserId, label, ordered, id) {
            const peerConnection = this.peerConnections.get(remoteUserId);
            const dataChannel = peerConnection.createDataChannel(
                label,
                { negotiated: true, id: id, ordered: ordered, protocol: 'clomega' }
            );
            this.handleDataChannel(dataChannel, remoteUserId, peerConnection.user);
            return dataChannel;
        }

        doesPeerExist(remoteUserId) {
            if (!this.peerConnections.get(remoteUserId)) return false;
            return (this.peerConnections.get(remoteUserId).connectionState == "connected");
        }

        doesPeerChannelExist(remoteUserId, channel) {
            if (!this.doesPeerExist(remoteUserId)) return false;
            return this.dataChannels.get(remoteUserId).has(channel);
        }

        createDefaultChannel(peerConnection, remoteUserId, remoteUserName) {
            const dataChannel = peerConnection.createDataChannel(
                "default",
                { negotiated: true, id: 0, ordered: true, protocol: 'clomega' }
            );
            this.handleDataChannel(dataChannel, remoteUserId, remoteUserName);
            return dataChannel;
        }

        disconnectDataPeer(remoteUserId) {
            const peerConnection = this.peerConnections.get(remoteUserId);
            if (peerConnection) {
                const remoteUserName = peerConnection.user;
                peerConnection.close();

                // Delete the peerConnection and all ICE candidates gathered
                this.peerConnections.delete(remoteUserId);
                delete this.iceCandidates[remoteUserId];
                
                // Clear all data channels
                if (this.dataChannels.has(remoteUserId)) {
                    const channels = this.dataChannels.get(remoteUserId);
                    for (const channel of channels.values()) {
                        channel.close();
                    }
                    this.dataChannels.delete(remoteUserId);
                }
    
                console.log(`Disconnected peer ${remoteUserName} (${remoteUserId}).`);
            }
        }
    
        onIceCandidate(remoteUserId, callback) {
            this.messageHandlers.onIceCandidate[remoteUserId] = callback;
        }
    
        onIceGatheringDone(remoteUserId, callback) {
            this.messageHandlers.onIceGatheringDone[remoteUserId] = callback;
        }
    
        onChannelOpen(remoteUserId, callback) {
            this.messageHandlers.onChannelOpen[remoteUserId] = callback;
        }
    
        onChannelClose(callback) {
            this.messageHandlers.onChannelClose = callback;
        }
    
        onChannelMessage(remoteUserId, callback) {
            this.messageHandlers.onChannelMessage[remoteUserId] = callback;
        }

        sendData(remoteUserId, channelLabel, opcode, payload, wait) {
            // Get peer.
            const peer = this.dataChannels.get(remoteUserId);

            if (!peer) {
                return;
            }

            // Get channel from peer.
            const channel = peer.get(channelLabel);

            if (!channel) {
                return;
            }

            if (wait) channel.bufferedAmountThreshold = 0; 

            channel.send(JSON.stringify({
                opcode,
                payload,
            }));

            if (wait) return new Promise((resolve) => {
                channel.onbufferedamountlow = () => {
                    resolve();
                }
            })
        }

        getChannelData(remoteUserId, channelLabel, channelDataType) {
            const peer = this.dataChannels.get(remoteUserId);
            if (!peer) return;
            const channel = peer.get(channelLabel);
            if (!channel) return;
            return channel.dataStorage.get(channelDataType);
        }

        removeIceCandidate(remoteUserId, candidate) {
            if (this.iceCandidates[remoteUserId].includes(candidate)) {
                this.iceCandidates[remoteUserId].splice(this.iceCandidates[remoteUserId].indexOf(candidate), 1);
            }
        }
    }

    // Define class to provide signaling for WebRTC and for WebSocket relay (too lazy to make a TURN server)
    class OmegaSignaling {
        constructor() {
            this.keepalive = null;
            this.messageHandlers = {
                onInitSuccess: null,
                onConnect: null,
                onClose: {},
                offer: null,
                answer: null,
                keepalive: null,
                onHostModeConfig: null,
                onPeerModeConfig: null,
                onModeConfigFailure: null,
                onNewHost: null,
                onAnticipate: null,
                onNewPeer: null,
                onPeerGone: {},
                onHostGone: {},
                onIceCandidateReceived: {},
                onOffer: null,
                onAnswer: null,
                listeners: {},
                onDiscover: null,
            };
            this.state = {
                user: "", // username
                id: "", // ULID
                game: "", // game name
                developer: "", // developer name
                mode: 0, // 0 - configuring, 1 - host, 2 - peer
            };
        }

        Connect(url) {
            this.socket = new WebSocket(url);

            this.socket.onopen = () => {

                // Start keepalive. Only upon successful reply should the keepalive keep running.
                this.sendMessage({ opcode: 'KEEPALIVE' });

                // Start external scripts.
                if (this.messageHandlers.onConnect) this.messageHandlers.onConnect();
            };

            this.socket.onclose = (event) => {

                // Clear values
                this.state.id = "";
                this.state.user = "";
                this.state.developer = "";
                this.state.game = "";
                this.state.mode = 0;
                this.socket = null;

                // Stop keepalive.
                clearTimeout(this.keepalive);

                // Call external scripts.
                Object.keys(this.messageHandlers.onClose).forEach(tag => {
                    this.messageHandlers.onClose[tag](event);
                })
            };

            this.socket.onerror = (error) => {
                console.error('Signaling connection error:', error);
            };

            this.socket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error handling message:', error);
                }
            };
        }

        handleMessage(message) {
            const { opcode, payload, origin, listener } = message;
            switch (opcode) {
                case 'INIT_OK':
                    console.log('Signaling login successful.');
                    this.state.user = payload.user;
                    this.state.id = payload.id;
                    this.state.game = payload.game;
                    this.state.developer = payload.developer;
                    if (this.messageHandlers.onInitSuccess) this.messageHandlers.onInitSuccess();
                    break;
                case "ACK_HOST":
                    console.log("Acknowledgement received: Operating in host mode.");
                    if (this.messageHandlers.onHostModeConfig) this.messageHandlers.onHostModeConfig();
                    this.state.mode = 1;
                    break;
                case "ACK_PEER":
                    console.log("Acknowledgement received: Operating in peer mode.");
                    if (this.messageHandlers.onPeerModeConfig) this.messageHandlers.onPeerModeConfig();
                    this.state.mode = 2;
                    break;
                case "VIOLATION":
                    console.error("Protocol violation: " + payload);
                    break;
                case "WARNING": 
                    console.warn("Protocol warning: " + payload);
                    break;
                case "CONFIG_REQUIRED":
                    console.warn("Configuration required: " + payload);
                    break;
                case "RELAY_OK":
                    break;
                case "KEEPALIVE":
                    this.keepalive = setTimeout(() => {
                        this.sendMessage({ opcode: 'KEEPALIVE' });
                    }, 5000); // 5 seconds delay
                    break;
                case "LOBBY_FULL":
                    console.warn("Lobby is full.");
                    if (this.messageHandlers.onModeConfigFailure) this.messageHandlers.onModeConfigFailure(opcode);
                    break;
                case "LOBBY_EXISTS":
                    console.warn("Lobby already exists.");
                    if (this.messageHandlers.onModeConfigFailure) this.messageHandlers.onModeConfigFailure(opcode);
                    break;
                case "LOBBY_NOTFOUND":
                    console.warn("Lobby does not exist.");
                    if (this.messageHandlers.onModeConfigFailure) this.messageHandlers.onModeConfigFailure(opcode);
                    break;
                case "LOBBY_LOCKED":
                    console.warn("Lobby is not accepting connections at this time.");
                    if (this.messageHandlers.onModeConfigFailure) this.messageHandlers.onModeConfigFailure(opcode);
                    break;
                case "PASSWORD_FAIL":
                    console.warn("Lobby is password protected and incorrect password was provided.");
                    if (this.messageHandlers.onModeConfigFailure) this.messageHandlers.onModeConfigFailure(opcode);
                    break;
                case "LOBBY_CLOSE":
                    console.log(`Lobby ${payload} closed.`);

                    // If we are a host/peer, we are required to disconnect.
                    if (this.state.mode == 1 || this.state.mode == 2) {
                        console.log("Disconnecting from lobby..");
                        this.Disconnect();
                    }

                    break;
                case "HOST_GONE":
                    console.log("The host has left.");
                    // To be compliant with the protocol, we must disconnect the host (or delete the object for it)
                    if (this.messageHandlers.onHostGone[payload]) this.messageHandlers.onHostGone[payload]();
                    break;
                case "PEER_GONE":
                    console.log(`Peer ${payload} has left.`);
                    // To be compliant with the protocol, we must disconnect the peer (or delete the object for it)
                    if (this.messageHandlers.onPeerGone[payload]) this.messageHandlers.onPeerGone[payload]();
                    break;
                case "SESSION_EXISTS":
                    console.warn("Protocol warning: Session already exists.");
                    break;
                case "TOKEN_INVALID":
                    console.warn("Protocol warning: Invalid token.");
                    break;
                case "TOKEN_EXPIRED":
                    console.warn("Protocol warning: Token expired.");
                    break;
                case "TOKEN_ORIGIN_MISMATCH":
                    console.warn("Protocol warning: Attempted to use a token generated on a different domain.");
                    break;
                case "DISCOVER":
                    if (this.messageHandlers.onDiscover) this.messageHandlers.onDiscover(message);
                    break;
                case "ANTICIPATE":
                    if (this.messageHandlers.onAnticipate) this.messageHandlers.onAnticipate(message);
                    break;
                case "NEW_PEER":
                    if (this.messageHandlers.onNewPeer) this.messageHandlers.onNewPeer(message);
                    break;
                case "NEW_HOST":
                    if (this.messageHandlers.onNewHost) this.messageHandlers.onNewHost(message);
                    break;
                case "MAKE_OFFER":
                    if (this.messageHandlers.onOffer) this.messageHandlers.onOffer(message);
                    break;
                case "MAKE_ANSWER":
                    if (this.messageHandlers.onAnswer) this.messageHandlers.onAnswer(message);
                    break;
                case "ICE":
                    if (this.messageHandlers.onIceCandidateReceived) this.messageHandlers.onIceCandidateReceived(message);
                    break;
            }

            // Call listeners   
            if (this.messageHandlers[listener]) this.messageHandlers[listener](message);
        }

        hostMode(lobby_id, allow_host_reclaim, allow_peers_to_claim_host, max_peers, password, pubkey, listener) {
            this.sendMessage({
                opcode: 'CONFIG_HOST',
                payload: {
                    lobby_id,
                    allow_host_reclaim,
                    allow_peers_to_claim_host,
                    max_peers,
                    password,
                    pubkey,
                },
                listener
            });
        }

        peerMode(lobby_id, password, pubkey, listener) {
            this.sendMessage({
                opcode: 'CONFIG_PEER',
                payload: {
                    lobby_id,
                    password,
                    pubkey,
                },
                listener
            });
        }

        authenticateWithToken(token, listener) {
            this.sendMessage({ opcode: 'INIT', payload: token, listener });
        }

        sendOffer(recipient, offer, listener) {
            this.sendMessage({ opcode: 'MAKE_OFFER', payload: offer, recipient, listener });
        }

        sendAnswer(recipient, answer, listener) {
            this.sendMessage({ opcode: 'MAKE_ANSWER', payload: answer, recipient, listener });
        }

        sendIceCandidate(recipient, answer, listener) {
            this.sendMessage({ opcode: 'ICE', payload: answer, recipient, listener });
        }

        Disconnect() {
            this.socket.close();
        }

        sendMessage(message) {
            if (this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify(message));
            } else {
                console.error('WebSocket connection not open. Cannot send message:', message);
            }
        }
        
        onAnswer(callback) {
            this.messageHandlers.onAnswer = callback;
        }

        onPeerGone(remoteUserId, callback) {
            this.messageHandlers.onPeerGone[remoteUserId] = callback;
        }

        onHostGone(remoteUserId, callback) {
            this.messageHandlers.onHostGone[remoteUserId] = callback;
        }
        
        onDiscover(callback) {
            this.messageHandlers.onDiscover = callback;
        }

        onAnticipate(callback) {
            this.messageHandlers.onAnticipate = callback;
        }

        onNewHost(callback) {
            this.messageHandlers.onNewHost = callback;
        }

        onNewPeer(callback) {
            this.messageHandlers.onNewPeer = callback;
        }

        onHostModeConfig(callback) {
            this.messageHandlers.onHostModeConfig = callback;
        }

        onPeerModeConfig(callback) {
            this.messageHandlers.onPeerModeConfig = callback;
        }

        onModeConfigFailure(callback) {
            this.messageHandlers.onModeConfigFailure = callback;
        }

        onIceCandidateReceived(callback) {
            this.messageHandlers.onIceCandidateReceived = callback;
        }

        onListener(name, callback) {
            this.messageHandlers.listeners[name] = callback;
        }

        onConnect(callback) {
            this.messageHandlers.onConnect = callback;
        }

        onInitSuccess(callback) {
            this.messageHandlers.onInitSuccess = callback;
        }

        onOffer(callback) {
            this.messageHandlers.onOffer = callback;
        }

        onClose(tag, callback) {
            this.messageHandlers.onClose[tag] = callback;
        }
    }

    // Initialize the extension classes so the two extensions can communicate
    const OmegaSignalingInstance = new OmegaSignaling();
    const OmegaRTCInstance = new OmegaRTC();
    const OmegaAuthInstance = new OmegaAuth();
    const OmegaEncryptionInstance = new OmegaEncryption();

    // Generate this peer's public / private key pair
    OmegaEncryptionInstance.generateKeyPair();
 
    // Define the extension for the CLΩ service
    class CloudLinkOmega {
        constructor(Scratch) {
            this.vm = Scratch.vm; // VM
            this.runtime = Scratch.vm.runtime; // Runtime

            // Define icons
            this.blockIconURI = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTc3IiBoZWlnaHQ9IjEyMyIgdmlld0JveD0iMCAwIDE3NyAxMjMiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxnIGNsaXAtcGF0aD0idXJsKCNjbGlwMF8xXzUzKSI+CjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMTM0LjMyIDM4LjUxMjlDMTU3LjU2MSAzOC41MTI5IDE3Ni4zOTkgNTcuMzUyMyAxNzYuMzk5IDgwLjU5MThDMTc2LjM5OSAxMDMuODMxIDE1Ny41NjEgMTIyLjY3MSAxMzQuMzIgMTIyLjY3MUg0Mi4wNzg5QzE4LjgzOCAxMjIuNjcxIDAgMTAzLjgzMSAwIDgwLjU5MThDMCA1Ny4zNTIzIDE4LjgzOCAzOC41MTI5IDQyLjA3ODkgMzguNTEyOUg0Ni4yNjc4QzQ4LjA3OTMgMTYuOTQyMyA2Ni4xNjEzIDAgODguMTk5MyAwQzExMC4yMzcgMCAxMjguMzE5IDE2Ljk0MjMgMTMwLjEzMSAzOC41MTI5SDEzNC4zMloiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xMTcuMjc4IDk4Ljk3MDNDMTE3LjI3OCAxMDEuMzY0IDExNS4zMzggMTAzLjMwNCAxMTIuOTQ0IDEwMy4zMDRIOTcuNTQ4MkM5NS4xNTQ5IDEwMy4zMDQgOTMuMjE0OCAxMDEuMzY0IDkzLjIxNDggOTguOTcwM1Y4OS42MTU4QzkzLjIxNDggODcuOTQwOCA5NC4xODAzIDg2LjQxNTkgOTUuNjk0MiA4NS42OTkxQzEwMS41ODUgODIuOTExIDEwNS4zOTEgNzYuOTAxMyAxMDUuMzkxIDcwLjM4ODlDMTA1LjM5MSA2MS4wNTQ2IDk3Ljc5NjcgNTMuNDYwNCA4OC40NjIyIDUzLjQ2MDRDNzkuMTI3NyA1My40NjA0IDcxLjUzMzcgNjEuMDU0NiA3MS41MzM3IDcwLjM4ODlDNzEuNTMzNyA3Ni45MDE1IDc1LjMzOTkgODIuOTExIDgxLjIzMDUgODUuNjk5MUM4Mi43NDQ1IDg2LjQxNTYgODMuNzEgODcuOTQwNiA4My43MSA4OS42MTU4Vjk4Ljk3MDNDODMuNzEgMTAxLjM2NCA4MS43NyAxMDMuMzA0IDc5LjM3NjYgMTAzLjMwNEg2My45ODAyQzYxLjU4NjkgMTAzLjMwNCA1OS42NDY4IDEwMS4zNjQgNTkuNjQ2OCA5OC45NzAzQzU5LjY0NjggOTYuNTc3IDYxLjU4NjkgOTQuNjM2OSA2My45ODAyIDk0LjYzNjlINzUuMDQzM1Y5Mi4xODc1QzcxLjgwMDIgOTAuMTg5NCA2OS4wMzQyIDg3LjQ4NzcgNjYuOTQ5NiA4NC4yNjA3QzY0LjI3ODcgODAuMTI2MiA2Mi44NjY5IDc1LjMyOTYgNjIuODY2OSA3MC4zODg5QzYyLjg2NjkgNTYuMjc1NSA3NC4zNDg5IDQ0Ljc5MzYgODguNDYyMiA0NC43OTM2QzEwMi41NzYgNDQuNzkzNiAxMTQuMDU4IDU2LjI3NTUgMTE0LjA1OCA3MC4zODg3QzExNC4wNTggNzUuMzI5NCAxMTIuNjQ2IDgwLjEyNjIgMTA5Ljk3NSA4NC4yNjA1QzEwNy44OTEgODcuNDg3NSAxMDUuMTI1IDkwLjE4OTQgMTAxLjg4MiA5Mi4xODc1Vjk0LjYzNjlIMTEyLjk0NEMxMTUuMzM4IDk0LjYzNjkgMTE3LjI3OCA5Ni41NzcgMTE3LjI3OCA5OC45NzAzWiIgZmlsbD0iI0ZGNEQ0QyIvPgo8L2c+CjxkZWZzPgo8Y2xpcFBhdGggaWQ9ImNsaXAwXzFfNTMiPgo8cmVjdCB3aWR0aD0iMTc2LjM5OSIgaGVpZ2h0PSIxMjIuNjcxIiBmaWxsPSJ3aGl0ZSIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+Cjwvc3ZnPgo=";

            // Define menu icon
            this.menuIconURI = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjI2IiBoZWlnaHQ9IjIyNiIgdmlld0JveD0iMCAwIDIyNiAyMjYiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxnIGNsaXAtcGF0aD0idXJsKCNjbGlwMF8xXzIpIj4KPHBhdGggZD0iTTAgMTEyLjY3N0MwIDUwLjQ0NzQgNTAuNDQ3NCAwIDExMi42NzcgMEMxNzQuOTA3IDAgMjI1LjM1NSA1MC40NDc0IDIyNS4zNTUgMTEyLjY3N0MyMjUuMzU1IDE3NC45MDcgMTc0LjkwNyAyMjUuMzU1IDExMi42NzcgMjI1LjM1NUM1MC40NDc0IDIyNS4zNTUgMCAxNzQuOTA3IDAgMTEyLjY3N1oiIGZpbGw9IiNGRjRENEMiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0xNTguNTM1IDgzLjc2MTJDMTgxLjc3NiA4My43NjEyIDIwMC42MTQgMTAyLjYwMSAyMDAuNjE0IDEyNS44NEMyMDAuNjE0IDE0OS4wOCAxODEuNzc2IDE2Ny45MTkgMTU4LjUzNSAxNjcuOTE5SDY2LjI5NDFDNDMuMDUzMiAxNjcuOTE5IDI0LjIxNTIgMTQ5LjA4IDI0LjIxNTIgMTI1Ljg0QzI0LjIxNTIgMTAyLjYwMSA0My4wNTMyIDgzLjc2MTIgNjYuMjk0MSA4My43NjEySDcwLjQ4M0M3Mi4yOTQ1IDYyLjE5MDcgOTAuMzc2NSA0NS4yNDg0IDExMi40MTQgNDUuMjQ4NEMxMzQuNDUyIDQ1LjI0ODQgMTUyLjUzNCA2Mi4xOTA3IDE1NC4zNDYgODMuNzYxMkgxNTguNTM1WiIgZmlsbD0id2hpdGUiLz4KPHBhdGggZD0iTTE0MS40OTMgMTQ0LjIxOUMxNDEuNDkzIDE0Ni42MTIgMTM5LjU1MyAxNDguNTUyIDEzNy4xNTkgMTQ4LjU1MkgxMjEuNzYzQzExOS4zNyAxNDguNTUyIDExNy40MyAxNDYuNjEyIDExNy40MyAxNDQuMjE5VjEzNC44NjRDMTE3LjQzIDEzMy4xODkgMTE4LjM5NSAxMzEuNjY0IDExOS45MDkgMTMwLjk0N0MxMjUuOCAxMjguMTU5IDEyOS42MDYgMTIyLjE1IDEyOS42MDYgMTE1LjYzN0MxMjkuNjA2IDEwNi4zMDMgMTIyLjAxMiA5OC43MDg3IDExMi42NzcgOTguNzA4N0MxMDMuMzQzIDk4LjcwODcgOTUuNzQ4OSAxMDYuMzAzIDk1Ljc0ODkgMTE1LjYzN0M5NS43NDg5IDEyMi4xNSA5OS41NTUxIDEyOC4xNTkgMTA1LjQ0NiAxMzAuOTQ3QzEwNi45NiAxMzEuNjY0IDEwNy45MjUgMTMzLjE4OSAxMDcuOTI1IDEzNC44NjRWMTQ0LjIxOUMxMDcuOTI1IDE0Ni42MTIgMTA1Ljk4NSAxNDguNTUyIDEwMy41OTIgMTQ4LjU1Mkg4OC4xOTU0Qzg1LjgwMiAxNDguNTUyIDgzLjg2MiAxNDYuNjEyIDgzLjg2MiAxNDQuMjE5QzgzLjg2MiAxNDEuODI1IDg1LjgwMiAxMzkuODg1IDg4LjE5NTQgMTM5Ljg4NUg5OS4yNTg1VjEzNy40MzZDOTYuMDE1NCAxMzUuNDM4IDkzLjI0OTQgMTMyLjczNiA5MS4xNjQ4IDEyOS41MDlDODguNDkzOSAxMjUuMzc1IDg3LjA4MjEgMTIwLjU3OCA4Ny4wODIxIDExNS42MzdDODcuMDgyMSAxMDEuNTI0IDk4LjU2NCA5MC4wNDIgMTEyLjY3NyA5MC4wNDJDMTI2Ljc5MSA5MC4wNDIgMTM4LjI3MyAxMDEuNTI0IDEzOC4yNzMgMTE1LjYzN0MxMzguMjczIDEyMC41NzggMTM2Ljg2MSAxMjUuMzc1IDEzNC4xOSAxMjkuNTA5QzEzMi4xMDYgMTMyLjczNiAxMjkuMzQgMTM1LjQzOCAxMjYuMDk3IDEzNy40MzZWMTM5Ljg4NUgxMzcuMTU5QzEzOS41NTMgMTM5Ljg4NSAxNDEuNDkzIDE0MS44MjUgMTQxLjQ5MyAxNDQuMjE5WiIgZmlsbD0iI0ZGNEQ0QyIvPgo8L2c+CjxkZWZzPgo8Y2xpcFBhdGggaWQ9ImNsaXAwXzFfMiI+CjxyZWN0IHdpZHRoPSIyMjUuMzU1IiBoZWlnaHQ9IjIyNS4zNTUiIGZpbGw9IndoaXRlIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==";
        }

        // Define blocks used in the extension
        getInfo() {
            return {
                id: 'clomega',
                name: 'CLΩ',
                docsURI: 'https://github.com/MikeDev101/cloudlink-omega/wiki/Client-Extension#clω-blocks',
                blockIconURI: this.blockIconURI,
                menuIconURI: this.menuIconURI,
                color1: "#FF4D4C",
                color2: "#FF7473",
                color3: "#A13332",
                blocks: [
                    {
                        opcode: 'get_token',
                        blockType: 'reporter',
                        text: 'My session token',
                    },
                    "---",
                    {
                        opcode: 'build_server_url',
                        blockType: 'reporter',
                        text: 'Get game [UGI] server URL',
                        arguments: {
                            UGI: {
                                type: 'string',
                                defaultValue: '01HNPHRWS0N0AYMM5K4HN31V4W',
                            },
                        }
                    },
                    "---",
                    {
                        opcode: 'login_account',
                        blockType: 'command',
                        text: 'Login with email: [EMAIL] password: [PASSWORD]',
                        arguments: {
                            EMAIL: {
                                type: 'string',
                                defaultValue: '',
                            },
                            PASSWORD: {
                                type: 'string',
                                defaultValue: '',
                            }
                        }
                    },
                    {
                        opcode: 'was_login_successful',
                        blockType: 'Boolean',
                        text: 'Was login successful?',
                    },
                    "---",
                    {
                        opcode: 'register_account',
                        blockType: 'command',
                        text: 'Register with email: [EMAIL] username: [USERNAME] password: [PASSWORD]',
                        arguments: {
                            EMAIL: {
                                type: 'string',
                                defaultValue: '',
                            },
                            USERNAME: {
                                type: 'string',
                                defaultValue: '',
                            },
                            PASSWORD: {
                                type: 'string',
                                defaultValue: '',
                            }
                        }
                    },
                    {
                        opcode: 'was_register_successful',
                        blockType: 'Boolean',
                        text: 'Was registration successful?',
                    },
                ]
            };
        }

        async login_account({ EMAIL, PASSWORD }) {
            await OmegaAuthInstance.Login(EMAIL, PASSWORD);
        }

        was_login_successful() {
            return OmegaAuthInstance.loginSuccess;
        }

        async register_account({ EMAIL, USERNAME, PASSWORD }) {
            await OmegaAuthInstance.Register(EMAIL, USERNAME, PASSWORD);
            return OmegaAuthInstance.registerSuccess;
        }

        was_register_successful() {
            return OmegaAuthInstance.registerSuccess;
        }

        get_token() {
            return OmegaAuthInstance.sessionToken;
        }

        build_server_url({UGI}) {
            let url = new URL(`${rootWsURL}/api/v0/signaling`);
            url.searchParams.append('ugi', UGI);
            return url.toString();
        }
    }

    // Define the extension for the CL5 protocol
    class CloudLink5 {
        constructor(Scratch) {
            this.vm = Scratch.vm; // VM
            this.runtime = Scratch.vm.runtime; // Runtime
            this.targets = Scratch.vm.runtime.targets // Access variables
            this.hasMicPerms = false;
            this.globalChannelMessages = new Map();
            
            // Define icons
            this.blockIconURI = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTc3IiBoZWlnaHQ9IjEyMyIgdmlld0JveD0iMCAwIDE3NyAxMjMiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxnIGNsaXAtcGF0aD0idXJsKCNjbGlwMF8xXzE5KSI+CjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMTM0LjMyIDM4LjUxMjlDMTU3LjU2MSAzOC41MTI5IDE3Ni4zOTkgNTcuMzUyMyAxNzYuMzk5IDgwLjU5MThDMTc2LjM5OSAxMDMuODMxIDE1Ny41NjEgMTIyLjY3MSAxMzQuMzIgMTIyLjY3MUg0Mi4wNzg5QzE4LjgzOCAxMjIuNjcxIDAgMTAzLjgzMSAwIDgwLjU5MThDMCA1Ny4zNTIzIDE4LjgzOCAzOC41MTI5IDQyLjA3ODkgMzguNTEyOUg0Ni4yNjc4QzQ4LjA3OTMgMTYuOTQyMyA2Ni4xNjEzIDAgODguMTk5MyAwQzExMC4yMzcgMCAxMjguMzE5IDE2Ljk0MjMgMTMwLjEzMSAzOC41MTI5SDEzNC4zMloiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik04Ny40MTk4IDEwNS4zMzNDODIuOTM3OCAxMDUuMzMzIDc4Ljc4NzggMTA0LjQ3NSA3NC45Njk4IDEwMi43NkM3MS4xNTE4IDEwMC45ODkgNjcuOTQyNSA5OC42NjUgNjUuMzQxOCA5NS43ODc3TDcxLjg5ODggODcuNTcwNkM3NC4yNzgyIDg5LjgzOTMgNzYuNzQwNSA5MS41ODIzIDc5LjI4NTggOTIuNzk5NkM4MS44ODY1IDk0LjAxNyA4NC40ODcyIDk0LjYyNTYgODcuMDg3OCA5NC42MjU2Qzg5LjUyMjUgOTQuNjI1NiA5MS42ODA1IDk0LjIzODMgOTMuNTYxOCA5My40NjM2Qzk1LjQ0MzIgOTIuNjMzNiA5Ni44ODE4IDkxLjQ5OTMgOTcuODc3OCA5MC4wNjA2Qzk4LjkyOTIgODguNTY2NiA5OS40NTQ4IDg2LjgyMzYgOTkuNDU0OCA4NC44MzE2Qzk5LjQ1NDggODIuOTUwMyA5OC45MjkyIDgxLjI5MDMgOTcuODc3OCA3OS44NTE2Qzk2LjgyNjUgNzguNDEzIDk1LjM4NzggNzcuMjc4NiA5My41NjE4IDc2LjQ0ODZDOTEuNzM1OCA3NS42MTg2IDg5LjY4ODUgNzUuMjAzNiA4Ny40MTk4IDc1LjIwMzZDODUuMzE3MiA3NS4yMDM2IDgzLjQzNTggNzUuMzk3MyA4MS43NzU4IDc1Ljc4NDZDODAuMTE1OCA3Ni4xNzIgNzguNjIxOCA3Ni42NDIzIDc3LjI5MzggNzcuMTk1NkM3NS45NjU4IDc3LjY5MzYgNzQuNzc2MiA3OC4yNDcgNzMuNzI0OCA3OC44NTU2TDY4LjA4MDggNzEuNjM0Nkw3MS42NDk4IDQ2LjMxOTZIMTA2LjUxVjU3LjAyNjZINzcuOTU3OEw4MC45NDU4IDUzLjM3NDZMNzguMjA2OCA3MS44MDA2TDc0LjMwNTggNjkuODkxNkM3NS4yNDY1IDY5LjExNyA3Ni41NDY4IDY4LjM5NzYgNzguMjA2OCA2Ny43MzM2Qzc5Ljg2NjggNjcuMDY5NiA4MS43MjA1IDY2LjUxNjMgODMuNzY3OCA2Ni4wNzM2Qzg1LjgxNTIgNjUuNjMxIDg3LjgzNDggNjUuNDA5NiA4OS44MjY4IDY1LjQwOTZDOTMuNzAwMiA2NS40MDk2IDk3LjI0MTUgNjYuMjM5NiAxMDAuNDUxIDY3Ljg5OTZDMTAzLjY2IDY5LjUwNDMgMTA2LjIzMyA3MS43NzMgMTA4LjE3IDc0LjcwNTZDMTEwLjEwNiA3Ny42MzgzIDExMS4wNzUgODEuMDY5IDExMS4wNzUgODQuOTk3NkMxMTEuMDc1IDg4LjgxNTYgMTEwLjAyMyA5Mi4yNzQgMTA3LjkyMSA5NS4zNzI3QzEwNS44MTggOTguNDE2IDEwMi45NjggMTAwLjg1MSA5OS4zNzE4IDEwMi42NzdDOTUuODMwNSAxMDQuNDQ3IDkxLjg0NjUgMTA1LjMzMyA4Ny40MTk4IDEwNS4zMzNaIiBmaWxsPSIjMEZCRDhDIi8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfMV8xOSI+CjxyZWN0IHdpZHRoPSIxNzYuMzk5IiBoZWlnaHQ9IjEyMi42NzEiIGZpbGw9IndoaXRlIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==";
            
            // Define menu icon
            this.menuIconURI = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjI2IiBoZWlnaHQ9IjIyNiIgdmlld0JveD0iMCAwIDIyNiAyMjYiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxnIGNsaXAtcGF0aD0idXJsKCNjbGlwMF8xXzEzKSI+CjxwYXRoIGQ9Ik0wIDExMi42NzdDMCA1MC40NDc0IDUwLjQ0NzQgMCAxMTIuNjc3IDBDMTc0LjkwNyAwIDIyNS4zNTUgNTAuNDQ3NCAyMjUuMzU1IDExMi42NzdDMjI1LjM1NSAxNzQuOTA3IDE3NC45MDcgMjI1LjM1NSAxMTIuNjc3IDIyNS4zNTVDNTAuNDQ3NCAyMjUuMzU1IDAgMTc0LjkwNyAwIDExMi42NzdaIiBmaWxsPSIjMEZCRDhDIi8+CjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMTU4LjUzNSA4My43NjEyQzE4MS43NzYgODMuNzYxMiAyMDAuNjE0IDEwMi42MDEgMjAwLjYxNCAxMjUuODRDMjAwLjYxNCAxNDkuMDggMTgxLjc3NiAxNjcuOTE5IDE1OC41MzUgMTY3LjkxOUg2Ni4yOTQxQzQzLjA1MzIgMTY3LjkxOSAyNC4yMTUyIDE0OS4wOCAyNC4yMTUyIDEyNS44NEMyNC4yMTUyIDEwMi42MDEgNDMuMDUzMiA4My43NjEyIDY2LjI5NDEgODMuNzYxMkg3MC40ODNDNzIuMjk0NSA2Mi4xOTA3IDkwLjM3NjUgNDUuMjQ4NCAxMTIuNDE0IDQ1LjI0ODRDMTM0LjQ1MiA0NS4yNDg0IDE1Mi41MzQgNjIuMTkwNyAxNTQuMzQ2IDgzLjc2MTJIMTU4LjUzNVoiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xMTEuNjM1IDE1MC41ODFDMTA3LjE1MyAxNTAuNTgxIDEwMy4wMDMgMTQ5LjcyMyA5OS4xODUgMTQ4LjAwOEM5NS4zNjcgMTQ2LjIzNyA5Mi4xNTc3IDE0My45MTMgODkuNTU3IDE0MS4wMzZMOTYuMTE0IDEzMi44MTlDOTguNDkzMyAxMzUuMDg4IDEwMC45NTYgMTM2LjgzMSAxMDMuNTAxIDEzOC4wNDhDMTA2LjEwMiAxMzkuMjY1IDEwOC43MDIgMTM5Ljg3NCAxMTEuMzAzIDEzOS44NzRDMTEzLjczOCAxMzkuODc0IDExNS44OTYgMTM5LjQ4NyAxMTcuNzc3IDEzOC43MTJDMTE5LjY1OCAxMzcuODgyIDEyMS4wOTcgMTM2Ljc0OCAxMjIuMDkzIDEzNS4zMDlDMTIzLjE0NCAxMzMuODE1IDEyMy42NyAxMzIuMDcyIDEyMy42NyAxMzAuMDhDMTIzLjY3IDEyOC4xOTkgMTIzLjE0NCAxMjYuNTM5IDEyMi4wOTMgMTI1LjFDMTIxLjA0MiAxMjMuNjYxIDExOS42MDMgMTIyLjUyNyAxMTcuNzc3IDEyMS42OTdDMTE1Ljk1MSAxMjAuODY3IDExMy45MDQgMTIwLjQ1MiAxMTEuNjM1IDEyMC40NTJDMTA5LjUzMiAxMjAuNDUyIDEwNy42NTEgMTIwLjY0NiAxMDUuOTkxIDEyMS4wMzNDMTA0LjMzMSAxMjEuNDIgMTAyLjgzNyAxMjEuODkxIDEwMS41MDkgMTIyLjQ0NEMxMDAuMTgxIDEyMi45NDIgOTguOTkxMyAxMjMuNDk1IDk3Ljk0IDEyNC4xMDRMOTIuMjk2IDExNi44ODNMOTUuODY1IDkxLjU2OEgxMzAuNzI1VjEwMi4yNzVIMTAyLjE3M0wxMDUuMTYxIDk4LjYyM0wxMDIuNDIyIDExNy4wNDlMOTguNTIxIDExNS4xNEM5OS40NjE3IDExNC4zNjUgMTAwLjc2MiAxMTMuNjQ2IDEwMi40MjIgMTEyLjk4MkMxMDQuMDgyIDExMi4zMTggMTA1LjkzNiAxMTEuNzY1IDEwNy45ODMgMTExLjMyMkMxMTAuMDMgMTEwLjg3OSAxMTIuMDUgMTEwLjY1OCAxMTQuMDQyIDExMC42NThDMTE3LjkxNSAxMTAuNjU4IDEyMS40NTcgMTExLjQ4OCAxMjQuNjY2IDExMy4xNDhDMTI3Ljg3NSAxMTQuNzUzIDEzMC40NDggMTE3LjAyMSAxMzIuMzg1IDExOS45NTRDMTM0LjMyMiAxMjIuODg3IDEzNS4yOSAxMjYuMzE3IDEzNS4yOSAxMzAuMjQ2QzEzNS4yOSAxMzQuMDY0IDEzNC4yMzkgMTM3LjUyMiAxMzIuMTM2IDE0MC42MjFDMTMwLjAzMyAxNDMuNjY0IDEyNy4xODQgMTQ2LjA5OSAxMjMuNTg3IDE0Ny45MjVDMTIwLjA0NiAxNDkuNjk2IDExNi4wNjIgMTUwLjU4MSAxMTEuNjM1IDE1MC41ODFaIiBmaWxsPSIjMEZCRDhDIi8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfMV8xMyI+CjxyZWN0IHdpZHRoPSIyMjUuMzU1IiBoZWlnaHQ9IjIyNS4zNTUiIGZpbGw9IndoaXRlIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==";
        }

        // Define blocks used in the extension
        getInfo() {
            return {
                id: 'cl5',
                name: 'CL5',
                docsURI: 'https://github.com/MikeDev101/cloudlink-omega/wiki/Client-Extension#cl5-blocks',
                blockIconURI: this.blockIconURI,
                menuIconURI: this.menuIconURI,
                color1: "#0FBD8C",
                color2: "#80C6B2",
                color3: "#0A7255",
                blocks: [
                    {
                        opcode: "on_signalling_connect",
                        blockType: "event",
                        text: "When I am connected to signaling server",
                        isEdgeActivated: false,
                    },
                    {
                        opcode: 'initialize',
                        blockType: 'command',
                        text: 'Connect to signaling server [SERVER]',
                        arguments: {
                            SERVER: {
                                type: 'string',
                                defaultValue: '',
                            },
                        }
                    },
                    {
                        opcode: 'authenticate',
                        blockType: 'command',
                        text: 'Authenticate with token [TOKEN]',
                        arguments: {
                            TOKEN: {
                                type: 'string',
                                defaultValue: '',
                            }
                        }
                    },
                    {
                        opcode: 'is_signalling_connected',
                        blockType: 'Boolean',
                        text: 'Connected to signaling server?',
                    },
                    "---",
                    {
                        opcode: 'my_ID',
                        blockType: 'reporter',
                        text: 'My Peer ID',
                    },
                    {
                        opcode: 'my_Username',
                        blockType: 'reporter',
                        text: 'My Username',
                    },
                    
                    "---",
                    {
                        opcode: 'get_peers',
                        blockType: 'reporter',
                        text: 'Connected peers',
                    },
                    {
                        opcode: 'get_peer_channels',
                        blockType: 'reporter',
                        text: 'Peer [PEER] channels',
                        arguments: {
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                    {
                        opcode: 'is_peer_connected',
                        blockType: 'Boolean',
                        text: 'Connected to peer [PEER]?',
                        arguments: {
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            }
                        }
                    },
                    "---",
                    {
                        opcode: "disconnect_peer",
                        blockType: "command",
                        text: "Close connection with peer [PEER]",
                        arguments: {
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                    {
                        opcode: "leave",
                        blockType: "command",
                        text: "Disconnect from signaling server",
                    },
                    "---",
                    {
                        opcode: 'init_host_mode',
                        blockType: 'command',
                        text: 'Host a lobby named [LOBBY], set the peer limit to [PEERS], set password to [PASSWORD], and [CLAIMCONFIG]',
                        arguments: {
                            LOBBY: {
                                type: 'string',
                                defaultValue: 'DemoLobby',
                            },
                            PEERS: {
                                type: 'number',
                                defaultValue: 0,
                            },
                            PASSWORD: {
                                type: 'string',
                                defaultValue: '',
                            },
                            CLAIMCONFIG: {
                                type: 'number',
                                menu: 'lobbyConfigMenu',
                                defaultValue: "1",
                            },
                        }
                    },
                    {
                        opcode: 'init_peer_mode',
                        blockType: 'command',
                        text: 'Join lobby [LOBBY] with password [PASSWORD]',
                        arguments: {
                            LOBBY: {
                                type: 'string',
                                defaultValue: 'DemoLobby',
                            },
                            PASSWORD: {
                                type: 'string',
                                defaultValue: '',
                            },
                        }
                    },
                    {
                        opcode: "get_client_mode",
                        blockType: "reporter",
                        text: "Am I a host or a peer?",
                    },
                    "---",
                    {
                        opcode: 'on_new_peer',
                        blockType: 'event',
                        isEdgeActivated: false,
                        text: 'When I get connected to a new peer',
                    },
                    {
                        opcode: "get_new_peer",
                        blockType: "reporter",
                        text: "Newest peer connected",
                    },
                    "---",
                    {
                        opcode: "on_broadcast_message",
                        blockType: "hat",
                        text: "When I get a broadcast message in channel [CHANNEL]",
                        isEdgeActivated: false,
                        arguments: {
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                        },
                    },
                    {
                        opcode: "on_private_message",
                        blockType: "hat",
                        text: "When I get a private message from peer [PEER] in channel [CHANNEL]",
                        isEdgeActivated: false,
                        arguments: {
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                    {
                        opcode: 'send',
                        blockType: 'command',
                        text: 'Send private data [DATA] to peer [PEER] using channel [CHANNEL] and wait for message to finish sending? [WAIT]',
                        arguments: {
                            DATA: {
                                type: 'string',
                                defaultValue: 'Hello',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            WAIT: {
                                type: 'Boolean',
                                defaultValue: false,
                            },
                        }
                    },
                    {
                        opcode: 'broadcast',
                        blockType: 'command',
                        text: 'Broadcast global data [DATA] to all peers using channel [CHANNEL] and wait for broadcast to finish sending? [WAIT]',
                        arguments: {
                            DATA: {
                                type: 'string',
                                defaultValue: 'Hello',
                            },
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            WAIT: {
                                type: 'Boolean',
                                defaultValue: false,
                            },
                        }
                    },
                    {
                        opcode: "channel_data_store_in_variable",
                        blockType: "command",
                        text: "Store received messages from peer [PEER]'s channel [CHANNEL] into variable [VAR]",
                        arguments: {
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                            VAR: {
                                type: 'string',
                                defaultValue: 'my variable',
                            },
                        },
                    },
                    "---",
                    {
                        opcode: "get_global_channel_data",
                        blockType: "reporter",
                        text: "Global channel [CHANNEL] data",
                        arguments: {
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                        },
                    },
                    {
                        opcode: "get_private_channel_data",
                        blockType: "reporter",
                        text: "Private channel [CHANNEL] data from peer [PEER]",
                        arguments: {
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            }
                        },
                    },
                    "---",
                    {
                        opcode: "on_channel_broadcast_networked_list",
                        blockType: "hat",
                        text: "When I get a broadcasted networked list named [LISTNAME] in channel [CHANNEL]",
                        isEdgeActivated: false,
                        arguments: {
                            LISTNAME: {
                                type: 'string',
                                defaultValue: 'my cloud list',
                            },
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                        },
                    },
                    {
                        opcode: "on_channel_private_networked_list",
                        blockType: "hat",
                        text: "When I get a private networked list named [LISTNAME] from peer [PEER] in channel [CHANNEL]",
                        isEdgeActivated: false,
                        arguments: {
                            LISTNAME: {
                                type: 'string',
                                defaultValue: 'my cloud list',
                            },
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                    {
                        opcode: "broadcast_networked_list",
                        blockType: "command",
                        text: "Broadcast networked list [LIST] to all peers using channel [CHANNEL] and wait for broadcast to finish sending? [WAIT]",
                        arguments: {
                            LIST: {
                                type: 'string',
                                defaultValue: 'my cloud list',
                            },
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            WAIT: {
                                type: 'Boolean',
                                defaultValue: false,
                            },
                        },
                    },
                    {
                        opcode: "send_networked_list",
                        blockType: "command",
                        text: "Send networked list [LIST] to peer [PEER] using channel [CHANNEL] and wait for list to finish sending? [WAIT]",
                        arguments: {
                            LIST: {
                                type: 'string',
                                defaultValue: 'my cloud list',
                            },
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                            WAIT: {
                                type: 'Boolean',
                                defaultValue: false,
                            },
                        },
                    },
                    {
                        opcode: "make_networked_list",
                        blockType: "command",
                        text: "Make list [LIST] a networked list named [LISTNAME] with peer [PEER] in channel [CHANNEL]",
                        arguments: {
                            LIST: {
                                type: 'string',
                                defaultValue: 'my list',
                            },
                            LISTNAME: {
                                type: 'string',
                                defaultValue: 'my cloud list',
                            },
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'default',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                    "---",
                    {
                        opcode: 'new_dchan',
                        blockType: 'command',
                        text: 'Open a new data channel named [CHANNEL] with peer [PEER] and make messages [ORDERED]',
                        arguments: {
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'foobar',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                            ORDERED: {
                                type: 'number',
                                menu: 'channelConfig',
                                defaultValue: "1",
                            },
                        },
                    },
                    {
                        opcode: 'close_dchan',
                        blockType: 'command',
                        text: 'Close data channel named [CHANNEL] with peer [PEER]',
                        arguments: {
                            CHANNEL: {
                                type: 'string',
                                defaultValue: 'foobar',
                            },
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                    "---",
                    {
                        opcode: "request_mic_perms",
                        blockType: "command",
                        text: "Request microphone access",
                    },
                    {
                        opcode: "get_mic_perms",
                        blockType: "reporter",
                        text: "Do I have microphone access?",
                    },
                    {
                        opcode: 'is_peer_vchan_open',
                        blockType: 'Boolean',
                        text: 'Connected to voice chat with peer [PEER]?',
                        arguments: {
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            }
                        }
                    },
                    {
                        opcode: 'change_mic_state',
                        blockType: 'command',
                        text: '[MICSTATE] my microphone with peer [PEER]',
                        arguments: {
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                            MICSTATE: {
                                type: 'number',
                                menu: 'micStateMenu',
                                defaultValue: "1",
                            },
                        },
                    },
                    {
                        opcode: 'new_vchan',
                        blockType: 'command',
                        text: 'Open a voice chat with peer [PEER]',
                        arguments: {
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                    {
                        opcode: 'close_vchan',
                        blockType: 'command',
                        text: 'Close voice chat with peer [PEER]',
                        arguments: {
                            PEER: {
                                type: 'string',
                                defaultValue: 'ID',
                            },
                        },
                    },
                ],
                menus: {
                    lobbyConfigMenu: {
                        items: [
                            {
                                text: "don\'t allow this lobby to be reclaimed",
                                value: "1",
                            },
                            {
                                text: "allow the server to reclaim the lobby",
                                value: "2",
                            },
                            {
                                text: "allow peers to reclaim the lobby",
                                value: "3",
                            }
                        ],
                    },
                    micStateMenu: {
                        items: [
                            {
                                text: "Mute",
                                value: "1",
                            },
                            {
                                text: "Unmute",
                                value: "2",
                            },
                        ],
                    },
                    channelConfig: {
                        items: [
                            {
                                text: "reliable/ordered (For reliability)",
                                value: "1",
                            },
                            {
                                text: "unreliable/unordered (For speed)",
                                value: "2",
                            },
                        ],
                    },
                }
            };
        }

        makeValueSafeForScratch(data) {
            try {
                // Check if data is a string
                if (typeof data === 'string') {
                    return data;
                // Check if data is an object/JSON
                } else if (typeof data === 'object' && data !== null) {
                    return JSON.stringify(data);
                } else {
                    // Return data as-is for other types
                    return data;
                }
            } catch (error) {
                // Return data as-is if conversion fails
                console.error(`Error making data ${data} vm-safe: ${error}`);
                return data;
            }
        }

        async clOmegaProtocolMessageHandler(remotePeerId, channel, message) {
            // Declare variables
            const self = this;
            let packet, sharedKey;
            
            // Parse message
            try {
                packet = JSON.parse(message);

                // Parse packet
                const opcode = packet.opcode;
                let payload = packet.payload;
                
                // Process packet
                switch (opcode) {
                    case "NEWCHAN": // Open a new data channel with custom settings
                        // Synchronize our channel ID counter
                        OmegaRTCInstance.peerConnections.get(remotePeerId).channelIdCounter = payload.id;

                        // Create channel
                        console.log(OmegaRTCInstance.createChannel(remotePeerId, payload.name, payload.ordered, payload.id));
                        break;
                    
                    case "G_MSG": // Global insecure message
                        self.globalChannelMessages.set(channel.label, payload);
                        break;
                    
                    case "G_VAR": // Global insecure variable
                        break;
                    
                    case "G_LIST": // Global insecure list
                        break;
                    
                    case "P_MSG": // Private secure message
                        sharedKey = await OmegaEncryptionInstance.getSharedKey(remotePeerId);
                        if (sharedKey) payload = await OmegaEncryptionInstance.decryptMessage(payload[0], payload[1], sharedKey);
                        channel.dataStorage.set("P_MSG", payload);
                        break;
                    
                    case "P_VAR": // Private secure variable
                        break;
                    
                    case "P_LIST": // Private secure list
                        break;
                    
                    case "RING": // Request to create voice channel
                        break;
                    
                    case "PICKUP": // Accept voice channel request
                        break;
                    
                    case "HANGUP": // Reject voice channel request / close voice channel
                        break;
                }

            } catch (error) {
                console.error(`Error handling peer ${remotePeerId}'s channel ${channel.label} message ${message}: ${error}`);
                return;
            }
        }

        initialize({ SERVER }) {
            const self = this;
            if (!OmegaSignalingInstance.socket) {
                return new Promise((resolve, reject) => {
                    OmegaSignalingInstance.Connect(SERVER);

                    // Return promise and begin listening for events 
                    OmegaSignalingInstance.onConnect(() => {
                        console.log('Connected to signaling server.');

                        // Return the promise.
                        resolve();
                    })

                    // Close all connections if the server disconnects
                    OmegaSignalingInstance.onClose("auto", () => {
                        console.log('Disconnected from signaling server.');

                        // To be compliant with the protocol, we must close all peer connections.
                        Array.from(OmegaRTCInstance.peerConnections.keys()).forEach((peer) => {
                            OmegaRTCInstance.disconnectDataPeer(peer);
                        })

                        // If this was a failed connection attempt, return the promise with a rejection.
                        reject();
                    })

                    // Prepare to handle a new incoming connection during an existing session
                    OmegaSignalingInstance.onAnticipate(async(message) => {
                        const remoteUserName = message.payload.user;
                        const remoteUserId = message.payload.id;
                        const pubKey = message.payload.pubkey;

                        // Create handler for PEER_GONE
                        OmegaSignalingInstance.onPeerGone(remoteUserId, () => {
                            OmegaRTCInstance.disconnectDataPeer(remoteUserId);
                        })

                        // Setup shared secret from public key (if provided)
                        if (pubKey) {
                            await OmegaEncryptionInstance.setSharedKeyFromPublicKey(remoteUserId, pubKey);
                        }
                    })

                    // Server advertises a new peer, we need to create a new peer connection
                    OmegaSignalingInstance.onDiscover(async(message) => {
                        const remoteUserName = message.payload.user;
                        const remoteUserId = message.payload.id;
                        const pubKey = message.payload.pubkey;
                        let sharedKey;

                        // Create handler for PEER_GONE
                        OmegaSignalingInstance.onPeerGone(remoteUserId, () => {
                            OmegaRTCInstance.disconnectDataPeer(remoteUserId);
                        })

                        // Setup shared secret from public key (if provided)
                        if (pubKey) {
                            await OmegaEncryptionInstance.setSharedKeyFromPublicKey(remoteUserId, pubKey);
                            sharedKey = await OmegaEncryptionInstance.getSharedKey(remoteUserId);
                        }

                        // Create offer
                        let offer = await OmegaRTCInstance.createDataOffer(remoteUserId, remoteUserName);

                        // Encrypt offer (if public key is provided)
                        if (sharedKey) {
                            let {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(JSON.stringify(offer), sharedKey);

                            // Send encrypted offer
                            OmegaSignalingInstance.sendOffer(
                                remoteUserId,
                                {
                                    type: 0, // data
                                    contents: [encryptedMessage, iv],
                                },
                                null,
                            );

                        } else {
                            // Send plaintext offer
                            OmegaSignalingInstance.sendOffer(
                                remoteUserId,
                                {
                                    type: 0, // data
                                    contents: offer,
                                },
                                null,
                            );

                        }
                    })

                    // Host receives a new peer, establish a new peer connection
                    OmegaSignalingInstance.onNewPeer(async(message) => {
                        const remoteUserName = message.payload.user;
                        const remoteUserId = message.payload.id;
                        const pubKey = message.payload.pubkey;
                        let sharedKey;

                        // Create handler for PEER_GONE
                        OmegaSignalingInstance.onPeerGone(remoteUserId, () => {
                            OmegaRTCInstance.disconnectDataPeer(remoteUserId);
                        })

                        // Setup shared secret from public key (if provided)
                        if (pubKey) {
                            await OmegaEncryptionInstance.setSharedKeyFromPublicKey(remoteUserId, pubKey);
                            sharedKey = await OmegaEncryptionInstance.getSharedKey(remoteUserId);
                        }

                        // Create offer
                        let offer = await OmegaRTCInstance.createDataOffer(remoteUserId, remoteUserName);

                        // Encrypt offer
                        if (sharedKey) {
                            let {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(JSON.stringify(offer), sharedKey);

                            // Send encrypted offer
                            OmegaSignalingInstance.sendOffer(
                                remoteUserId, 
                                {
                                    type: 0, // data
                                    contents: [encryptedMessage, iv],
                                }, 
                                null
                            );

                        } else {
                            // Send plaintext offer
                            OmegaSignalingInstance.sendOffer(
                                remoteUserId, 
                                {
                                    type: 0, // data
                                    contents: offer,
                                }, 
                                null
                            );

                        }
                    })

                    // Peer receives a new host, prepare for an offer
                    OmegaSignalingInstance.onNewHost(async(message) => {
                        const remoteUserName = message.payload.user;
                        const remoteUserId = message.payload.id;
                        const lobby = message.payload.lobby_id;
                        const pubKey = message.payload.pubkey;

                        console.log(`New lobby ${lobby} created by host ${remoteUserName} (${remoteUserId})`);

                        // Create handler for HOST_GONE
                        OmegaSignalingInstance.onHostGone(remoteUserId, () => {
                            OmegaRTCInstance.disconnectDataPeer(remoteUserId);
                        })

                        // Setup shared secret from public key (if provided)
                        if (pubKey) {
                            await OmegaEncryptionInstance.setSharedKeyFromPublicKey(remoteUserId, pubKey);
                        }
                    })

                    // Handle ICE candidates
                    OmegaSignalingInstance.onIceCandidateReceived(async(message) => {
                        const remoteUserName = message.origin.user;
                        const remoteUserId = message.origin.id;
                        const sharedKey = await OmegaEncryptionInstance.getSharedKey(remoteUserId);
                        let type = message.payload.type;
                        let candidate = message.payload.contents;

                        // Decrypt ICE candidate
                        if (sharedKey) {
                            let encryptedMessage = candidate[0];
                            let iv = candidate[1];
                            candidate = JSON.parse(await OmegaEncryptionInstance.decryptMessage(encryptedMessage, iv, sharedKey));
                        }

                        // Handle candidate
                        switch (type) {
                            case 0: // data
                                OmegaRTCInstance.addDataIceCandidate(remoteUserId, candidate);
                                break;
                            case 1: // voice
                                OmegaRTCInstance.addVoiceIceCandidate(remoteUserId, candidate);
                                break;
                        }
                    })

                    // Handle offers
                    OmegaSignalingInstance.onOffer(async(message) => {
                        const remoteUserName = message.origin.user;
                        const remoteUserId = message.origin.id;
                        const sharedKey = await OmegaEncryptionInstance.getSharedKey(remoteUserId);
                        let answer;
                        let offer = message.payload.contents;
                        let type = message.payload.type;   

                        // Decrypt offer
                        if (sharedKey) {
                            let encryptedMessage = offer[0];
                            let iv = offer[1];
                            offer = JSON.parse(await OmegaEncryptionInstance.decryptMessage(encryptedMessage, iv, sharedKey));
                        }
                    
                        // Create answer
                        switch (type) {
                            case 0: // data
                                answer = await OmegaRTCInstance.createDataAnswer(remoteUserId, remoteUserName, offer);
                                break;
                            case 1: // voice
                                answer = await OmegaRTCInstance.createVoiceAnswer(remoteUserId, remoteUserName, offer);
                                break;
                        }
                        
                        // Encrypt answer
                        if (sharedKey) {
                            let {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(JSON.stringify(answer), sharedKey);
                            
                            // Send encrypted answer
                            OmegaSignalingInstance.sendAnswer(
                                remoteUserId, 
                                {
                                    type: 0, // data
                                    contents: [encryptedMessage, iv],
                                }, 
                                null
                            );

                        } else {
                            // Send plaintext answer
                            OmegaSignalingInstance.sendAnswer(
                                remoteUserId, 
                                {
                                    type: 0, // data
                                    contents: answer,
                                }, 
                                null
                            );

                        }

                        // Begin handling incoming messages
                        OmegaRTCInstance.onChannelMessage(remoteUserId, async(message, channel) => {
                            await self.clOmegaProtocolMessageHandler(remoteUserId, channel, message);
                        })

                        // Send Trickle ICE candidates
                        OmegaRTCInstance.onIceCandidate(remoteUserId, async(candidate) => {

                            // Encrypt ICE candidate if public key is provided, otherwise send it unencrypted
                            if (sharedKey) {

                                let {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(
                                    JSON.stringify(candidate), 
                                    sharedKey,
                                );

                                OmegaSignalingInstance.sendIceCandidate(
                                    remoteUserId, 
                                    {
                                        type: 0, // data
                                        contents: [encryptedMessage, iv],
                                    },
                                );

                            } else {
                                OmegaSignalingInstance.sendIceCandidate(
                                    remoteUserId, 
                                    {
                                        type: 0, // data
                                        contents: candidate,
                                    },
                                );
                            }

                            // Remove the candidate from the queue so we don't accidentally resend it
                            OmegaRTCInstance.removeIceCandidate(remoteUserId, candidate);
                        })

                        // Send final ICE candidates when done gathering
                        OmegaRTCInstance.onIceGatheringDone(remoteUserId, () => {
                            
                            OmegaRTCInstance.iceCandidates[remoteUserId].forEach(async(candidate) => {

                                // Encrypt ICE candidate if public key is provided, otherwise send it unencrypted
                                if (sharedKey) {

                                    let {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(
                                        JSON.stringify(candidate), 
                                        sharedKey,
                                    );

                                    OmegaSignalingInstance.sendIceCandidate(
                                        remoteUserId, 
                                        {
                                            type: 0, // data
                                            contents: [encryptedMessage, iv],
                                        },
                                    );

                                } else {
                                    OmegaSignalingInstance.sendIceCandidate(
                                        remoteUserId, 
                                        {
                                            type: 0, // data
                                            contents: candidate,
                                        },
                                    );
                                }

                                // Cleanup candidates queue
                                OmegaRTCInstance.removeIceCandidate(remoteUserId, candidate);
                            })
                        })
                    })

                    // Handle answers
                    OmegaSignalingInstance.onAnswer(async(message) => {
                        const remoteUserId = message.origin.id;
                        const sharedKey = await OmegaEncryptionInstance.getSharedKey(remoteUserId);
                        let type = message.payload.type;
                        let answer = message.payload.contents;

                        // Decrypt answer
                        if (sharedKey) {
                            let encryptedMessage = answer[0];
                            let iv = answer[1];
                            answer = JSON.parse(await OmegaEncryptionInstance.decryptMessage(encryptedMessage, iv, sharedKey));
                        }

                        // Handle answer
                        switch (type) {
                            case 0: // data
                                await OmegaRTCInstance.handleDataAnswer(remoteUserId, answer);
                                break;
                            case 1: // voice
                                await OmegaRTCInstance.handleVoiceAnswer(remoteUserId, answer);
                                break;
                        }

                        // Begin handling incoming messages
                        OmegaRTCInstance.onChannelMessage(remoteUserId, async(message, channel) => {
                            await self.clOmegaProtocolMessageHandler(remoteUserId, channel, message);
                        })

                        // Send Trickle ICE candidates
                        OmegaRTCInstance.onIceCandidate(remoteUserId, async(candidate) => {

                            // Encrypt ICE candidate if public key is provided, otherwise send it unencrypted
                            if (sharedKey) {

                                let {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(
                                    JSON.stringify(candidate), 
                                    sharedKey,
                                );

                                OmegaSignalingInstance.sendIceCandidate(
                                    remoteUserId, 
                                    {
                                        type: 0, // data
                                        contents: [encryptedMessage, iv],
                                    },
                                );

                            } else {
                                OmegaSignalingInstance.sendIceCandidate(
                                    remoteUserId, 
                                    {
                                        type: 0, // data
                                        contents: candidate,
                                    },
                                );
                            }

                            // Remove the candidate from the queue so we don't accidentally resend it
                            OmegaRTCInstance.removeIceCandidate(remoteUserId, candidate);
                        })

                        // Send final ICE candidates when done gathering
                        OmegaRTCInstance.onIceGatheringDone(remoteUserId, () => {
                            
                            OmegaRTCInstance.iceCandidates[remoteUserId].forEach(async(candidate) => {

                                // Encrypt ICE candidate if public key is provided, otherwise send it unencrypted
                                if (sharedKey) {

                                    let {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(
                                        JSON.stringify(candidate), 
                                        sharedKey,
                                    );

                                    OmegaSignalingInstance.sendIceCandidate(
                                        remoteUserId, 
                                        {
                                            type: 0, // data
                                            contents: [encryptedMessage, iv],
                                        },
                                    );

                                } else {
                                    OmegaSignalingInstance.sendIceCandidate(
                                        remoteUserId, 
                                        {
                                            type: 0, // data
                                            contents: candidate,
                                        },
                                    );
                                }

                                // Cleanup candidates queue
                                OmegaRTCInstance.removeIceCandidate(remoteUserId, candidate);
                            })
                        })
                    })
                });
            }
        }

        init_host_mode({LOBBY, PEERS, PASSWORD, CLAIMCONFIG}) {
            const self = this;
            return new Promise(async(resolve, reject) => {
                if (!OmegaSignalingInstance.socket) {
                    console.warn('Signaling server not connected');
                    reject();
                    return;
                }
                let allow_host_reclaim = false;
                let allow_peers_to_claim_host = false;
                switch (CLAIMCONFIG) {
                    case 1:
                        allow_host_reclaim = false;
                        allow_peers_to_claim_host = false;
                        break;
                    case 2:
                        allow_host_reclaim = true;
                        allow_peers_to_claim_host = false;
                        break;
                    case 3:
                        allow_host_reclaim = true;
                        allow_peers_to_claim_host = true;
                        break;
                }
                OmegaSignalingInstance.hostMode(
                    LOBBY,
                    allow_host_reclaim,
                    allow_peers_to_claim_host,
                    PEERS,
                    PASSWORD,
                    await OmegaEncryptionInstance.exportPublicKey(),
                    null
                );

                OmegaSignalingInstance.onHostModeConfig(() => {
                    resolve();
                })

                OmegaSignalingInstance.onModeConfigFailure(() => {
                    reject();
                })
            })
        }

        init_peer_mode({LOBBY, PASSWORD}) {
            const self = this;
            return new Promise(async(resolve, reject) => {
                if (!OmegaSignalingInstance.socket) {
                    console.warn('Signaling server not connected');
                    reject();
                    return;
                }

                OmegaSignalingInstance.peerMode(
                    LOBBY,
                    PASSWORD,
                    await OmegaEncryptionInstance.exportPublicKey(),
                    null,
                );

                OmegaSignalingInstance.onPeerModeConfig(() => {
                    resolve();
                })

                OmegaSignalingInstance.onModeConfigFailure(() => {
                    reject();
                })
            })
        }

        send({DATA, PEER, CHANNEL, WAIT}) {
            // TODO: figure out a way to improve performance (this block, even if you tell it to not wait, it still takes time to send messages)
            const sharedKey = OmegaEncryptionInstance.getSharedKey(PEER);
            if (sharedKey) {
                return new Promise(async(resolve) => {
                    const {encryptedMessage, iv} = await OmegaEncryptionInstance.encryptMessage(DATA, sharedKey);
                    DATA = [encryptedMessage, iv];
                    OmegaRTCInstance.sendData(
                        PEER,
                        CHANNEL,
                        "P_MSG",
                        DATA,
                        WAIT,
                    );
                    resolve();
                })
            }
            else {
                OmegaRTCInstance.sendData(
                    PEER,
                    CHANNEL,
                    "P_MSG",
                    DATA,
                    WAIT,
                );
            }
        }

        broadcast({DATA, CHANNEL, WAIT}) {
            if (WAIT) {
                let promises = [];

                // Get all peers and prepare promises
                for (const remotePeerId of Object.values(OmegaRTCInstance.getPeers())) {
                    promises.push(
                        OmegaRTCInstance.sendData(
                            remotePeerId,
                            CHANNEL,
                            "G_MSG",
                            DATA,
                            true,
                        )
                    );
                }
            
                // Send all messages
                return Promise.all(promises);
            }
            else {

                // Send and do not wait for messages to be sent
                for (const remotePeerId of Object.values(OmegaRTCInstance.getPeers())) {
                    OmegaRTCInstance.sendData(
                        remotePeerId,
                        CHANNEL,
                        "G_MSG",
                        DATA,
                        false,
                    );
                }
            }
        }

        disconnect_peer({PEER}) {
            const self = this;
            OmegaRTCInstance.disconnectDataPeer(PEER);
        }

        leave() {
            const self = this;
            if (!OmegaSignalingInstance.socket) {
                return;
            }
            return new Promise((resolve) => {
                OmegaSignalingInstance.Disconnect();
                OmegaSignalingInstance.onClose("manual", () => {
                    resolve();
                })
            })
        }

        is_signalling_connected() {
            if (!OmegaSignalingInstance.socket) return false;
            return (OmegaSignalingInstance.socket.readyState === 1);
        }

        my_ID() {
            return OmegaSignalingInstance.state.id;
        }

        my_Username() {
            return OmegaSignalingInstance.state.user;
        }

        get_peers() {
            const self = this;
            return self.makeValueSafeForScratch(OmegaRTCInstance.getPeers());
        }

        authenticate({TOKEN}) {
            if (!OmegaSignalingInstance.socket) {
                console.warn('Signaling server not connected');
                return;
            };
            OmegaSignalingInstance.authenticateWithToken(TOKEN, null);
        }

        // Request microphone permission
        async request_mic_perms() {
            const self = this;
            self.hasMicPerms = false;

            // Try to get microphone permission
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
                self.hasMicPerms = true;
            } catch (e) {
                console.warn(`Failed to get microphone permission. ${e}`);
                return;
            }
        }

        get_mic_perms() {
            const self = this;
            return self.hasMicPerms;
        }

        new_dchan({CHANNEL, PEER, ORDERED}) {
            const self = this;

            // Check if peer exists
            if (!OmegaRTCInstance.doesPeerExist(PEER)) {
                console.warn(`Peer ${PEER} not found.`);
                return;
            }

            // Get the current peer channel ID incrementer value and add 1
            let channelIdCounter = OmegaRTCInstance.peerConnections.get(PEER).channelIdCounter;
            channelIdCounter += 1;

            // Send NEWCHAN to the peer over the default channel
            OmegaRTCInstance.sendData(
                PEER,
                "default",
                "NEWCHAN",
                {
                    name: CHANNEL,
                    ordered: (ORDERED == 1),
                    id: channelIdCounter,
                },
                true,
            );

            // Create the channel on our end and wait for the peer to connect to it on their end
            console.log(OmegaRTCInstance.createChannel(PEER, CHANNEL, (ORDERED == 1), channelIdCounter));
        }

        new_vchan({PEER}) {
            const self = this;

            // Check if peer exists
            if (!OmegaRTCInstance.doesPeerExist(PEER)) {
                console.warn(`Peer ${PEER} not found.`);
                return;
            }

            // self.WebRTC.openVoiceStream(PEER);
        }

        change_mic_state({MICSTATE, PEER}) {
            
        }

        is_peer_vchan_open({PEER}) {

        }

        close_vchan({PEER}) {
            const self = this;

            // Check if peer exists
            if (!OmegaRTCInstance.doesPeerExist(PEER)) {
                console.warn(`Peer ${PEER} not found.`);
                return;
            }

            // self.WebRTC.closeVoiceStream(PEER);
        }
        
        close_dchan({CHANNEL, PEER}) {
            const self = this;
            if (CHANNEL == "default") {
                console.warn("You may not close the default data channel.");
                return;
            }

            // Check if peer exists
            if (!OmegaRTCInstance.doesPeerExist(PEER)) {
                console.warn(`Peer ${PEER} not found.`);
                return;
            }

            if (!OmegaRTCInstance.dataChannels.get(PEER).get(CHANNEL)) {
                console.warn(`Channel ${CHANNEL} does not exist for peer ${PEER}`);
                return;
            }

            OmegaRTCInstance.dataChannels.get(PEER).get(CHANNEL).close();
        }

        get_peer_channels({PEER}) {
            const self = this;
            return self.makeValueSafeForScratch(OmegaRTCInstance.getPeerChannels(PEER));
        }

        is_peer_connected({PEER}) {
            const self = this;
            return OmegaRTCInstance.doesPeerExist(PEER);
        }

        get_global_channel_data({CHANNEL}) {
            const self = this;
            if (!self.globalChannelMessages.has(CHANNEL)) return "";
            return self.makeValueSafeForScratch(self.globalChannelMessages.get(CHANNEL));
        }

        get_private_channel_data({CHANNEL, PEER}) {
            const self = this;
            if (!OmegaRTCInstance.doesPeerExist(PEER)) return "";
            if (!OmegaRTCInstance.doesPeerChannelExist(PEER, CHANNEL)) return "";
            return self.makeValueSafeForScratch(
                OmegaRTCInstance.dataChannels.get(PEER).get(CHANNEL).dataStorage.get("P_MSG")
            );
        }

        channel_data_store_in_variable({CHANNEL, PEER, VAR}) {
        
        }

        get_client_mode() {
            const self = this;
            if (OmegaSignalingInstance.state.mode == 1) {
                return "host";
            } else if (OmegaSignalingInstance.state.mode == 2) {
                return "peer";
            } else return "";
        }

        make_networked_list({LIST, PEER, CHANNEL}) {

        }

        send_networked_list({LIST, CHANNEL, PEER, WAIT}) {

        }

        broadcast_networked_list({LIST, CHANNEL, WAIT}) {

        }

        on_channel_private_networked_list() {

        }

        on_channel_broadcast_networked_list() {

        }

        on_private_message({PEER, CHANNEL}) {

        }

        on_broadcast_message({CHANNEL}) {

        }

        get_new_peer() {

        }
    };

    /*
    Scratch.vm.runtime.on('BEFORE_EXECUTE', () => {
        Scratch.vm.runtime.startHats('cl5_on_private_message');
        Scratch.vm.runtime.startHats('cl5_on_broadcast_message');
        Scratch.vm.runtime.startHats('cl5_on_channel_private_networked_list');
        Scratch.vm.runtime.startHats('cl5_on_channel_broadcast_networked_list');
    });*/

    Scratch.extensions.register(new CloudLinkOmega(Scratch));
    Scratch.extensions.register(new CloudLink5(Scratch));
})(Scratch);
