import { Tinio, TinioSession }  from '../../src/tinio.js'

export const testers = {

    "Test-1-Normal": async () => {
        let cp_on_validate_session = false
        let cp_validate_session_data_ok = false
        let cp_on_aquire_session = false
        let cp_on_session_established = false
        let cp_on_message = false
        let cp_request_ok = false
        let cp_message_ok = false
        let cp_on_session_terminated = false

        const server = new Tinio()
        server.delegate.onValidateSession = async (r:number, peer: string, data:any) => {
            console.log('onValidateSession Triggered')
            cp_on_validate_session = true
            if(data.val == 10)
                cp_validate_session_data_ok = true
            else
                console.log('server-side onValidateSession data not ok', data)
            return "GOOD"
        }
        server.delegate.onAcquireSession = async (r:number, peer: string) => {
            console.log('onAquireSession Triggered')
            cp_on_aquire_session = true
            return {val:20}
        }
        server.delegate.onSessionEstablished = async (ses: TinioSession) => {
            console.log('onSessionEstablished Triggered')
            cp_on_session_established = true
            if(ses.data != "GOOD") throw new Error('session data not ok')
        }
        server.delegate.onMessage = async (ses: TinioSession, msg: string, data?: Record<string, unknown>) => {
            console.log('onMessage Triggered')
            cp_on_message = true
            if(msg == 'msg'){
                console.log('onMessage data ok')
                cp_message_ok = true
            }else if(msg == 'req'){
                console.log('onRequest data ok')
                cp_request_ok = true
                return {val:40}
            }
        }
        server.delegate.onSessionTerminated = (ses: TinioSession) => {
            console.log('onSessionTerminated Triggered')
            cp_on_session_terminated = true
        }

        const client = new Tinio
        client.delegate.onAcquireSession = async (r:number, peer: string) => {
            return {val:10}
        }
        client.delegate.onValidateSession = async (r:number, peer: string, data:any) => {
            if(data.val == 20)
                return true
            console.log('client-side onValidateSession data not ok', data)
            return false
        }

        await server.startListen({
            port: 18080,
        })

        console.log(server.listenInfo)

        const clises = await client.aquireSession("ws://127.0.0.1:18080")

        await clises.send('msg', {val:30})
        const rep = await clises.request('req', {val:30})

        if(rep.val != 40) throw new Error('request data not ok')

        clises.terminate()

        server.stopListen()

        server.halt()

        if(!cp_on_validate_session) throw new Error('onValidateSession not triggered')
        if(!cp_validate_session_data_ok) throw new Error('onValidateSession data not ok')
        if(!cp_on_aquire_session) throw new Error('onAquireSession not triggered')
        if(!cp_on_session_established) throw new Error('onSessionEstablished not triggered')
        if(!cp_on_message) throw new Error('onMessage not triggered')
        if(!cp_message_ok) throw new Error('onMessage data not ok')
        if(!cp_on_session_terminated) throw new Error('onSessionTerminated not triggered')
    }
}