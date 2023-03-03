import * as WebSocket from "ws"
import https from "https"
import os from "os"


// This is the handshake package in tinio protocol.
// The handshake package is used to establish a connection between two tinio nodes.
// In tinio network, each node listens on a port and accepts connections from other nodes.
// Once a node want to connect to another node, it will create a websocket connection to the peer.
// After the connection is established, the node will send a handshake package to the peer:
//
//          TinioHandshakePack {
//              type: "tinio-req",
//              url:  "the url on which the node is listening",
//              inf:  "an combination data, the low 16 bits is the port number. can be combined with other data, see remarks",
//              data: "any data from upper layer"
//          }
//
// When the peer receives the handshake package, it will check the url. the url is used to identify
// the node. It stands for the url on which the node is listening. If the url is null, the peer will
// attempt to guess the url according the following rules:
//
//        - If the inf & 0x10000 == 0x10000, the protocol is wss, otherwise the protocol is ws.
//
//        - The node must know which port it is listening on, the port number is in the low 16 bits
//          of the inf field.
//
//        - Use the ip address of the node as the host name to construct the url.
//
//      For example, the url could be the following form:
//
//          <ws|wss>://<ipaddr>:<TinioHandshakePack.inf & 0xffff>
//
// After the peer has processed the url, it will check if the url is already in its connection pool.
// the peer will decline the connection by sending a handshake package:
//
//          TinioHandshakePack {
//              type: "tinio-ack",
//              inf:  1
//          }
//
// If the url is not in use, the peer will accept the connection and keep it in a connection pool.
// The peer will also send a handshake package back to the node:
//
//          TinioHandshakePack {
//              type: "tinio-ack",
//              url: "the node's url",
//              inf: 0,
//              data: "any data from upper layer"
//          }
//
// In the ack package, the url is the url on which the peer has marked the node in its connection pool.
// If the node don't know its own url, it can use the url in the ack package.
// Basically, if all nodes are running in the same network, the url guessed by any peer should be correct.
// Based on this assumption, the Tinio could be running in the following scenarios:
//
//      - All nodes are running in the same network, the url guessed by any peer should be correct.
//
//      - If a node won't be connected by any other nodes, that means the node is playing the role of
//        a client, in this case, the node can be running in any network which can reache the peer.
//


type TinioHandshakePack = {
    type: "tinio-req" | "tinio-ack",
    url?: string,
    inf: number,
    data?: any
}

export type OnTinioConnected = (url: string) => Promise<void>
export type OnTinioDisconnected = (url: string) => Promise<void>
export type OnTinioReceived = (url: string, data: any) => Promise<any>
export type OnTinioAuthrequest = (url: string) => Promise<any>
export type OnTinioAuthcheck = (url: string, data: any) => Promise<boolean>

export type WebSocketServerOptions = WebSocket.ServerOptions

export type TinioConfigure = {
    url?: string,        // The url could be reached by the other server
    net:{
        host?: string,   // The host to listen
        port?: number,   // The port to listen
        backlog?: number, // The backlog to listen
        rejectUnauthorized?: boolean, // Reject unauthorized ssl connections
        perMessageDeflate?: boolean, // Enable per message deflate
        ssl?:{
            cert: string,   // The content to the certificate file
            key: string     // The content to the key file
        }
    }
    onConnected?: OnTinioConnected,
    onDisconnected?: OnTinioDisconnected,
    onReceived?: OnTinioReceived,
    onAuthrequest?: OnTinioAuthrequest,
    onAuthcheck?: OnTinioAuthcheck
}

export type TinioProperties = {
    online: boolean,
    url?: string,
    net:{
        address: string,
        port: number,
        family: string,
        secure: boolean
    }
}

export class Tinio {
    /** @internal */ private _wss: WebSocket.WebSocketServer | undefined
    /** @internal */ private _cfg: TinioConfigure
    /** @internal */ private _connections: Map<string, WebSocket.WebSocket> = new Map()
    /** @internal */ private _onTinioConnected: OnTinioConnected | undefined
    /** @internal */ private _onTinioDisconnected: OnTinioDisconnected | undefined
    /** @internal */ private _onTinioReceived: OnTinioReceived | undefined
    /** @internal */ private _onTinioAuthrequest: OnTinioAuthrequest | undefined
    /** @internal */ private _onTinioAuthcheck: OnTinioAuthcheck | undefined

    constructor(cfg: TinioConfigure) {
        this._cfg = cfg
        this._onTinioConnected = cfg.onConnected
        this._onTinioDisconnected = cfg.onDisconnected
        this._onTinioReceived = cfg.onReceived
        this._onTinioAuthcheck = cfg.onAuthcheck
        this._onTinioAuthrequest = cfg.onAuthrequest
    }

    start(): boolean {
        const options:any = {
            host: this._cfg.net.host,
            port: this._cfg.net.port || 0,
            backlog: this._cfg.net.backlog || 100,
            rejectUnauthorized: this._cfg.net.rejectUnauthorized || false,
            perMessageDeflate: this._cfg.net.perMessageDeflate || false
        };
        if(this._cfg.net.ssl){
            options.key = this._cfg.net.ssl.key;
            options.cert = this._cfg.net.ssl.cert;
            const srv = https.createServer(options);
            this._wss = new WebSocket.WebSocketServer({server: srv});
            srv.listen(options.port, options.host);
        }else{
            this._wss = new WebSocket.WebSocketServer(options);
        }
        this._wss.on('connection', (ws: WebSocket.WebSocket) => {
            const _tinio = this;
            ws.onmessage = async (event: WebSocket.MessageEvent) => {
                try{
                    const data = JSON.parse(event.data.toString()) as TinioHandshakePack;
                    if(data.type === "tinio-req"){
                        if(data.url == null){
                            // Guess the url
                            const inf = data.inf
                            const port = inf & 0xffff
                            const host = (ws as any)._socket.remoteAddress;
                            const protocol = (inf & 0x10000)?'wss':'ws'
                            data.url = `${protocol}://${host}:${port}`
                        }
                        // Check if the url is already in use
                        if(this._connections.has(data.url) || (this._onTinioAuthcheck && (await this._onTinioAuthcheck(data.url, data.data)) == false)){
                            // Send the error pack back and close the connection
                            await _tinio._send(ws, {
                                type: "tinio-ack",
                                inf: 1
                            })
                            throw 1;
                        } else {
                            await _tinio._send(ws, {
                                type: "tinio-ack",
                                url: data.url,
                                inf: 0,
                                data: (this._onTinioAuthrequest)?(await this._onTinioAuthrequest(data.url)):null
                            })
                            await _tinio._createConnection(data.url, ws)
                        }
                    }
                }catch(e){ ws.onmessage = null; ws.close(); }
            }
        })
        return true
    }

    /** @internal */ private async _closeConnection(url: string, ws: WebSocket.WebSocket, removeFromSet: boolean = true){
        ws.onerror = null
        ws.onclose = null
        ws.close()
        if(removeFromSet) this._connections.delete(url)
        if(this._onTinioDisconnected) return this._onTinioDisconnected(url)
    }

    /** @internal */ private async _send(ws: WebSocket.WebSocket, data: any){
        try{
            ws.send(JSON.stringify(data))
        }catch(e){ }
    }

    /** @internal */ private async _receiveMessage(url: string, ws: WebSocket.WebSocket, data: string){
        if(this._onTinioReceived){
            let _data = null
            try{ _data = JSON.parse(data)}catch(e){}
            const rep = await this._onTinioReceived(url, _data)
            if(rep) this._send(ws, rep)
        }
    }

    /** @internal */ private async _createConnection(url: string, ws: WebSocket.WebSocket){
        ws.onerror = async (event: WebSocket.ErrorEvent) => { return this._closeConnection(url, ws) }
        ws.onclose = async (event: WebSocket.CloseEvent) => { return this._closeConnection(url, ws) }
        ws.onmessage = async (event: WebSocket.MessageEvent) => {if(this._onTinioReceived) return this._receiveMessage(url, ws, event.data.toString()) }
        this._connections.set(url, ws)
        if(this._onTinioConnected) await this._onTinioConnected(url)
    }

    /**
     * Fetch a connection from the url
     * 
     * - If the connection is already established, return the connection
     * - If the connection is not established, try to establish the connection
     */
    /** @internal */ private async _getConnectionFromUrl(url: string): Promise<WebSocket.WebSocket|null>{
        // Fetch the connection from the pool.
        const ews = this._connections.get(url)
        if(ews) return ews

        // Attempt to establish a new connection
        return new Promise((resolve, reject) => {
            const ws = new WebSocket.WebSocket(url)
            ws.onopen = async (event: WebSocket.Event) => {
                const req:TinioHandshakePack = {
                    type: "tinio-req",
                    url: this._cfg.url,
                    inf: 0,
                    data: this._onTinioAuthrequest?(await this._onTinioAuthrequest(url)):null
                }
                const addr = this._wss?.address() as WebSocket.AddressInfo;
                if(addr) req.inf = addr.port;
                if(this._cfg.net.ssl) req.inf = req.inf & 0x10000;
                ws.send(JSON.stringify(req))
                ws.onmessage = async (event: WebSocket.MessageEvent) => {
                    try{
                        const data = JSON.parse(event.data.toString()) as TinioHandshakePack;
                        if(data.type !== "tinio-ack" || data.inf !== 0) throw 1;
                        if(!this._cfg.url) this._cfg.url = data.url;
                        if(this._onTinioAuthcheck && ((await this._onTinioAuthcheck(url, data.data)) == false)) throw 1;
                        this._createConnection(url, ws)
                        resolve(ws)
                    }catch(e){
                        ws.onerror = null;
                        ws.onclose = null;
                        ws.onmessage = null;
                        ws.onopen = null;
                        ws.close();
                        return resolve(null);
                    }
                }
                
            }
            ws.onerror = async (event: WebSocket.ErrorEvent) => { return resolve(null); }
            ws.onclose = async (event: WebSocket.CloseEvent) => { return resolve(null); }
        });
    }

    stop(): void {
        for (const [url, ws] of this._connections)
            this._closeConnection(url, ws, true)
        this._connections.clear()
        if(this._wss){
            this._wss.close()
            this._wss = undefined
        }
    }

    /**
     * Send a message to the given url
     * @param url the destination url
     * @param data anything what could be serialized in JSON
     * @returns true if the data was sent successfully, false otherwise
     */
    async send(url: string, data: any): Promise<boolean> {
        // Fetch the connection
        const ws = await this._getConnectionFromUrl(url)
        if(ws){
            this._send(ws, data)
            return true
        }
        return false
    }

    get connections(): string[] {
        return Array.from(this._connections.keys())
    }

    get properties(): TinioProperties {
        const ret = {
            online: false,
            url: this._cfg.url,
            net:{
                address: '',
                port: 0,
                family: '',
                secure: this._cfg.net.ssl?true:false
            }
        } as TinioProperties;

        if(this._wss){
            const addrInfo = this._wss.address() as WebSocket.AddressInfo
            if(addrInfo){
                ret.net.address = addrInfo.address + os.hostname
                ret.net.family = addrInfo.family
                ret.net.port = addrInfo.port
                ret.online = true
            }
        }

        return ret;
    }

}