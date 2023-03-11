export type SessionRequest = {
    cmd: 'session-request'
    data: any
}

export type SessionAck = {
    cmd: 'session-ack' | 'session-reject'
    data: any
}

export type Msg = {
    cmd: 'msg'
    msg: string
    data: any
}

export type Req = {
    cmd: 'req'
    rid: string
    msg: string
    data: any
}

export type Ack = {
    cmd: 'ack'
    rid: string
    data: any
}