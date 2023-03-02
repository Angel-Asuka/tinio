import * as WebSocket from "ws"
import https from "https"

export type OnTinioConnected = (url: string) => Promise<void>
export type OnTinioDisconnected = (url: string) => Promise<void>
export type OnTinioReceived = (url: string, data: any) => Promise<any>

export type WebSocketServerOptions = WebSocket.ServerOptions

export type TinioConfigure = {
    url: string,        // The url could be reached by the other server
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
    },
    options: WebSocketServerOptions,
    onConnected: OnTinioConnected | undefined,
    onDisconnected: OnTinioDisconnected | undefined,
    onReceived: OnTinioReceived | undefined
}

export class Tinio {
    /** @internal */ private _wss: WebSocket.WebSocketServer | undefined
    /** @internal */ private _cfg: TinioConfigure
    /** @internal */ private _connections: Map<string, WebSocket.WebSocket> = new Map()
    /** @internal */ private _onTinioConnected: OnTinioConnected | undefined
    /** @internal */ private _onTinioDisconnected: OnTinioDisconnected | undefined
    /** @internal */ private _onTinioReceived: OnTinioReceived | undefined

    constructor(cfg: TinioConfigure) {
        this._cfg = cfg
        this._onTinioConnected = cfg.onConnected
        this._onTinioDisconnected = cfg.onDisconnected
        this._onTinioReceived = cfg.onReceived
    }

    start(): boolean {
        const options:any = {
            host: this._cfg.net.host,
            port: this._cfg.net.port,
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
                    const data = JSON.parse(event.data.toString());
                    if(data.type === "tinio" && data.src_url){
                        await _tinio._createConnection(data.src_url, ws)
                    }
                }catch(e){}
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

    /** @internal */ private async _getConnectionFromUrl(url: string): Promise<WebSocket.WebSocket|null>{
        const ews = this._connections.get(url)
        if(ews) return ews
        return new Promise((resolve, reject) => {
            const ws = new WebSocket.WebSocket(url)
            ws.onopen = async (event: WebSocket.Event) => {
                ws.send(JSON.stringify({type: "tinio", src_url: this._cfg.url}))
                this._createConnection(url, ws)
                resolve(ws)
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
        const ws = await this._getConnectionFromUrl(url)
        if(ws){
            this._send(ws, data)
            return true
        }
        return false
    }
}