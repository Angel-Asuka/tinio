# tinio

## Introduction

tinio is a tiny peer-to-peer communication library for Typescript and Javascript. It's focused on data transmission.

To use this library, simply create a tinio object, and send data to the other:

```TypeScript
// Create a tinio object
const tinio = new Tinio({
    url: "ws://myhost",
    options: { // This param will pass through to the constructor of WebSocket
        port: 8080
    },

    // Declare a message callback.
    onReceived: (url: string, data: any) => {
        // url is the peer's url.
        // data is already deserialized.
        // return an un-null object will send a reply to the sender.
        return  {msg: 'My reply'}
    }
} as TinioConfigure)

// We simply send an object to the other
// the object will be serialized automatic
tinio.send("ws://somone_s_url", {msg: "Hello"})
```