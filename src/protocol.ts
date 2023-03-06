export type SessionRequest = {
    cmd: 'session-request'
    data: any
}

export type SessionAck = {
    cmd: 'session-ack' | 'session-reject'
    data: any
}