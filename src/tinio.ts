import * as WebSocket from 'ws'
import https from 'https'
import { randomUUID } from 'crypto'
import { SessionRequest, SessionAck, Msg, Req, Ack } from './protocol.js'
import { apply_from } from '@acsl/toolbox'

const kCreateSession = Symbol()
const kRemoveSession = Symbol()

export type TinioListenParams = {
    port?: number
    address?: string
    path?: string
    ssl? :{
        cert: string,
        key: string
    }
}

export type TinioDelegate = {
    onAquireSession: (peer:string, info:any)=>Promise<any>
    onValidateSession: (peer:string, data:any, info:any)=>Promise<boolean>
    onSessionEstablished: (session: TinioSession)=>Promise<void>
    onSessionTerminated: (session: TinioSession)=>void
    onMessage: (session: TinioSession, message: string, data?: Record<string, unknown>)=>Promise<Record<string, unknown>|void>
    onError: (err: TinioError)=>void
}

const TinioErrorMessages = [
    'Unknown error',            // Unknown
    'Reject by peer',           // Reject
    'Invalid data',             // InvalidData origin = any
    'Connection Reset',         // Reset origin = WebSocket.CloseEvent
    'Connection Error',         // Error origin = WebSocket.ErrorEvent
    'Timeout',                  // Timeout
    'Canceled',                 // Canceled
    'Application error'         // AppError
]

export class TinioError extends Error {
    reason: number
    message: string
    peer: string
    data?: any
    session?: TinioSession
    origin?: Error | WebSocket.CloseEvent | WebSocket.ErrorEvent | any

    constructor(reason: number, peer:string, data?: any, ses?: TinioSession, origin?: Error | WebSocket.CloseEvent | WebSocket.ErrorEvent | any){
        reason = reason < 0 || reason >= TinioErrorMessages.length ? 0 : reason
        super(`TinioError: ${TinioErrorMessages[reason]}`)
        this.name = 'TinioError'
        this.reason = reason
        this.message = TinioErrorMessages[reason]
        this.peer = peer
        this.data = data
        this.session = ses
        this.origin = origin
    }

    static readonly Unknown         = 0
    static readonly Reject          = 1
    static readonly InvalidData     = 2
    static readonly Reset           = 3
    static readonly Error           = 4
    static readonly Timeout         = 5
    static readonly Canceled        = 6
    static readonly AppError        = 7
}

export class TinioSession {

    /** @internal */ private _uuid : string
    /** @internal */ private _peer : string
    /** @internal */ private _sock : WebSocket.WebSocket | null
    /** @internal */ private _tinio : Tinio
    /** @internal */ private _data : any
    /** @internal */ private _delegate : TinioDelegate
    /** @internal */ private _direction : number
    /** @internal */ private _reqs : Map<string, (data: any)=>void> = new Map()

    /** @internal */ private constructor(peer: string, dir:number, sock: WebSocket.WebSocket, tinio: Tinio, delegate: TinioDelegate){
        this._uuid = randomUUID()
        this._peer = peer
        this._direction = dir
        this._sock = sock
        this._tinio = tinio
        this._delegate = delegate
        this._sock.onmessage = this._onMessage.bind(this)
        this._sock.onclose = this._onClose.bind(this)
        this._sock.onerror = this._onError.bind(this)
    }

    /** @internal */ static [kCreateSession](peer:string, dir:number, sock:WebSocket.WebSocket, tinio:Tinio, delegate: TinioDelegate): TinioSession {
        return new TinioSession(peer, dir, sock, tinio, delegate)
    }

    /** @internal */ private async _onMessage(event: WebSocket.MessageEvent) {
        try{
            const msg = JSON.parse(event.data.toString())
            try{
                if(msg.cmd === 'msg'){
                    const req = msg as Msg
                    const res = await this._delegate.onMessage(this, req.msg, req.data)
                    if(res != null){
                        await this._send({
                            cmd: 'msg',
                            msg: req.msg,
                            data: res
                        })
                    }
                }else if(msg.cmd === 'req'){
                    const req = msg as Req
                    const res = await this._delegate.onMessage(this, req.msg, req.data)
                    await this._send({
                        cmd: 'ack',
                        rid: req.rid,
                        data: res
                    })
                }else if(msg.cmd === 'ack'){
                    const ack = msg as Ack
                    const cb = this._reqs.get(ack.rid)
                    if(cb != null){
                        // Call cb directly, the record will be removed by the callback
                        cb(ack.data)
                    }
                }else{
                    // Otherwise, ignore the message
                    this._delegate.onError(new TinioError(TinioError.InvalidData, this._peer, msg, this))
                }
            }catch(e){
                this._delegate.onError(new TinioError(TinioError.AppError, this._peer, msg, this, e))
            }
        }catch(e){
            this._delegate.onError(new TinioError(TinioError.InvalidData, this._peer, event.data, this, e))
        }
    }

    /** @internal */ private async _onClose(/* event: WebSocket.CloseEvent */) {
        return this.terminate()
    }

    /** @internal */ private async _onError(event: WebSocket.ErrorEvent) {
        this._delegate.onError(new TinioError(TinioError.Error, this._peer, undefined, this, event))
        return this.terminate()
    }

    /**
     * Send a package through the session
     */
    /** @internal */ private async _send(pkg: Record<string, unknown>): Promise<void> {
        try{
            const msg = JSON.stringify(pkg)
            if(this._sock == null || this._sock.readyState !== WebSocket.WebSocket.OPEN){
                throw new TinioError(TinioError.Reset, this._peer, pkg, this)
            }
            await this._sock.send(msg)
        }catch(e){
            if(e instanceof TinioError){
                throw e
            }else{
                throw new TinioError(TinioError.InvalidData, this._peer, pkg, this, e)
            }
        }
    }

    /**
     * Send a message to the peer
     * 
     * @param msg - Message name
     * @param data - Message data
     * @remarks
     * Send a message to the peer. The promise will be fulfilled when the peer
     * receives the message. If the peer sends a response, another onMessage event
     * will be triggered.
     */
    async send(msg: string, data?: any): Promise<void> {
        await this._send({
            cmd: 'msg',
            msg: msg,
            data: data
        })
    }

    /**
     * Send a request to the peer
     * 
     * @param msg - Message name
     * @param data - Message data
     * @returns - Response data
     * @remarks
     * Send a request to the peer. The promise will be fulfilled when the peer
     * responds to the request. If the peer does not respond within the timeout
     * period, the promise will be rejected.
     */
    async request(msg: string, data?: any): Promise<any> {
        const rid = randomUUID()
        const p = new Promise((resolve, reject) => {
            const tid = setTimeout(() => {
                this._reqs.delete(rid)
                reject(new TinioError(TinioError.Timeout, this._peer, data, this))
            }, this._tinio.requestTimeout)
            const solve = (data: any) => {
                clearTimeout(tid)
                this._reqs.delete(rid)
                resolve(data)
            }
            this._reqs.set(rid, solve)
        })
        await this._send({
            cmd: 'req',
            rid: rid,
            msg: msg,
            data: data
        })
        return p
    }

    /**
     * Terminate the session
     */
    terminate() {
        if(this._sock != null){
            this._sock.removeAllListeners()
            this._sock.close()
            this._sock = null
            this._delegate.onSessionTerminated(this)
            this._tinio[kRemoveSession](this)
        }
    }

    /**
     * The unique ID for this session
     */
    get uuid(): string { return this._uuid }

    /**
     * The peer URL
     */
    get peer(): string { return this._peer }

    /**
     * User data
     */
    get data(): any { return this._data }

    /**
     * User data
     */
    set data(d:any) { this._data = d }

    /**
     * Determine if the session is alive
     */
    get alive(): boolean { return (this._sock != null && this._sock.readyState === WebSocket.WebSocket.OPEN) }

    /**
     * Determine if the session is Outgoing
     */
    get direction(): number { return this._direction }

    static readonly Incoming = 0
    static readonly Outgoing = 1

}

export class Tinio {

    /** @internal */ private _connect_timeout = 10000
    /** @internal */ private _request_timeout = 10000
    /** @internal */ private _connections : Map<string, TinioSession> = new Map()
    /** @internal */ private _delegate : TinioDelegate = {
        /* eslint-disable @typescript-eslint/no-empty-function */
        onAquireSession: async (_peer:string)=>{},
        onValidateSession: async (_peer:string, _data:any)=>{ return true },
        onSessionEstablished: async (_session: TinioSession)=>{},
        onSessionTerminated: async (_session: TinioSession)=>{},
        onMessage: async (_session: TinioSession, _message: string, _data?: Record<string, unknown>)=>{},
        onError: (_err: TinioError)=>{}
        /* eslint-enable @typescript-eslint/no-empty-function */
    }

    /** @internal */ private _listen_params : TinioListenParams = { port: 0 }
    /** @internal */ private _ws : WebSocket.Server | null = null

    constructor(){
        
    }

    /**
     * Start to accept session requests
     * 
     * @returns {boolean} true if the server started successfully
     */
    startListen(params? : TinioListenParams): boolean {
        apply_from(this._listen_params, params)
        if(this._listen_params.port == null) this._listen_params.port = 0

        if(this._listen_params.ssl){
            const server = https.createServer(this._listen_params.ssl)
            this._ws = new WebSocket.Server({ server })
            server.listen(this._listen_params.port, this._listen_params.address)
        }else{
            this._ws = new WebSocket.WebSocketServer({
                host: this._listen_params.address,
                port: this._listen_params.port,
                path: this._listen_params.path
            })
        }

        this._ws.on('connection', async (sock: WebSocket.WebSocket)=>{
            const remote_addr = (sock as any)?._socket?.remoteAddress
            if(!remote_addr){
                sock.close()
                return
            }
            try{
                const event: WebSocket.MessageEvent = await new Promise((resolve, reject)=>{
                    const tid = setTimeout(()=>reject(new TinioError(TinioError.Timeout, remote_addr)), this._connect_timeout)
                    sock.onmessage = (event: WebSocket.MessageEvent)=>(clearTimeout(tid), resolve(event))
                    sock.onerror = (event: WebSocket.ErrorEvent)=>(clearTimeout(tid), reject(new TinioError(TinioError.Error, remote_addr, undefined, undefined, event)))
                    sock.onclose = (event: WebSocket.CloseEvent)=>(clearTimeout(tid), reject(new TinioError(TinioError.Reset, remote_addr, undefined, undefined, event)))
                })

                const msg = JSON.parse(event.data.toString()) as SessionRequest
                if(msg.cmd !== 'session-request'){
                    throw new TinioError(TinioError.InvalidData, remote_addr, msg)
                }

                if(await this._delegate.onValidateSession(remote_addr, msg.data, undefined) === false){
                    throw new TinioError(TinioError.Canceled, remote_addr, msg)
                }

                const ack: SessionAck = {
                    cmd: 'session-ack',
                    data: await this._delegate.onAquireSession(remote_addr, undefined)
                }
                sock.send(JSON.stringify(ack))
                const ses = TinioSession[kCreateSession](remote_addr, TinioSession.Incoming, sock, this, this._delegate)
                this._connections.set(ses.uuid, ses)
                await this._delegate.onSessionEstablished(ses)

            }catch(e){
                sock.close()
                if(e instanceof TinioError){
                    this._delegate.onError(e)
                }else{
                    this._delegate.onError(new TinioError(TinioError.Error, remote_addr, undefined, undefined, e))
                }
            }
        })

        return true
    }

    /**
     * Stop to accept session requests
     */
    stopListen() {
        if(this._ws){
            this._ws.close()
            this._ws = null
        }
    }

    /**
     * Shutdown Tinio
     * This will stop listen and terminate all sessions
     */
    async halt() {
        this.stopListen()
        const snapshot = Array.from(this._connections.values())
        for(const session of snapshot){
            await session.terminate()
        }
    }

    /** @internal */ [kRemoveSession](session: TinioSession) {
        this._connections.delete(session.uuid)
    }

    /**
     * Aquire a session with a peer
     * 
     * @param peer - The URL to the peer
     * @param info - User data to be transmitted to the onAquireSession and onValidateSession, 
     *               this parameter is optional and will not be transmitted to the peer.
     *               Application can use this parameter to pass user data to the delegate methods.
     * @returns 
     */
    async aquireSession(peer:string, info?: any): Promise<TinioSession> {
        return new Promise((resolve, reject)=>{
            const sock = new WebSocket.WebSocket(peer)
            sock.onopen = async ()=>{
                try{
                    const req : SessionRequest = {
                        cmd: 'session-request',
                        data: await this._delegate.onAquireSession(peer, info)
                    }
                    sock.send(JSON.stringify(req));
                    (sock as any).tid = setTimeout(()=>{
                        sock.removeAllListeners()
                        sock.close()
                        reject(new TinioError(TinioError.Timeout, peer))
                    }, this._connect_timeout)
                }catch(e){
                    sock.removeAllListeners()
                    sock.close()
                    reject(new TinioError(TinioError.Unknown, peer, undefined, undefined, e))
                }
            }
            const close_reject = (reason: any)=>{
                clearTimeout((sock as any).tid)
                sock.removeAllListeners()
                sock.close()
                reject(reason)
            }
            sock.onmessage = async (event: WebSocket.MessageEvent)=>{
                try{
                    const ack = JSON.parse(event.data.toString()) as SessionAck
                    if(ack.cmd === 'session-ack'){
                        if(await this._delegate.onValidateSession(peer, ack.data, info) == false){
                            close_reject(new TinioError(TinioError.Canceled, peer))
                        }
                        clearTimeout((sock as any).tid)
                        const ses = TinioSession[kCreateSession](peer, TinioSession.Outgoing, sock, this, this._delegate)
                        this._connections.set(ses.uuid, ses)
                        await this._delegate.onSessionEstablished(ses)
                        resolve(ses)
                    } else if(ack.cmd === 'session-reject'){
                        close_reject(new TinioError(TinioError.Reject, peer, ack.data))
                    } else {
                        close_reject(new TinioError(TinioError.InvalidData, peer, event.data))
                    }
                }catch(e){
                    close_reject(new TinioError(TinioError.InvalidData, peer, event.data, undefined, e))
                }
            }
            sock.onerror = (event: WebSocket.ErrorEvent)=>{
                close_reject(new TinioError(TinioError.Error, peer, undefined, undefined, event))
            }
            sock.onclose = (event: WebSocket.CloseEvent)=>{
                close_reject(new TinioError(TinioError.Reset, peer, undefined, undefined, event))
            }
        })
    }

    get delegate(): TinioDelegate { return this._delegate }

    /**
     * Determine if the Tinio is listening
     */
    get listening(): boolean { return false }

    /**
     * Retrieve all alive sessions
     */
    get sessions(): TinioSession[] { return Array.from(this._connections.values()) }

    /**
     * Retrieve the number of alive sessions
     */
    get sessionCount(): number { return this._connections.size }

    /**
     * Retrieve the connect timeout
     */
    get connectTimeout(): number { return this._connect_timeout }

    /**
     * Set the connect timeout
     */
    set connectTimeout(timeout: number) { this._connect_timeout = timeout }

    /**
     * Retrieve the request timeout
     */
    get requestTimeout(): number { return this._request_timeout }

    /**
     * Set the request timeout
     */
    set requestTimeout(timeout: number) { this._request_timeout = timeout }
}

