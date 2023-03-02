// Description: Test the tinio module

import process from "process"
import { Tinio, TinioConfigure } from "../src/tinio.js"

console.log("Begin tinio testing >>>>>>>>>>>")

let tinio1_check = false
let tinio2_check = false

const tinio1 = new Tinio({
    url: "ws://localhost:8080",
    net: {
        port: 8080
    },
    onReceived: (url: string, data: any) => {
        console.log("tinio1 received message from tinio2")
        console.log("----- tinio1 received data: ", data)
        if(data.msg === "Hello") tinio1_check = true
    }
} as TinioConfigure)

const tinio2 = new Tinio({
    url: "ws://localhost:8081",
    net: {
        port: 8081
    },
    onReceived: (url: string, data: any) => {
        console.log("tinio2 received message from tinio1")
        console.log("----- tinio2 received data: ", data)
        if(data.msg === "Hello") tinio2_check = true
        return data
    }
} as TinioConfigure)

console.log("Starting tinio1")
tinio1.start()

console.log("Starting tinio2")
tinio2.start()

console.log("Sending 'Hello' from tinio1 to tinio2")
tinio1.send("ws://localhost:8081", {msg: "Hello"})

console.log("Waiting for tinio1 to receive 'Hello' from tinio2")
let check_times = 0

while(!tinio1_check){
    check_times++
    if(check_times > 10){
        console.log("tinio1 did not receive 'Hello' from tinio2")
        console.log("FAILED")
        process.exit(1)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
}

console.log("tinio1 received 'Hello' from tinio2")

tinio1_check = false
console.log("Sending 'Hello' from tinio2 to tinio1")
tinio2.send("ws://localhost:8080", {msg: "Hello"})

check_times = 0

while(!tinio1_check){
    check_times++
    if(check_times > 10){
        console.log("tinio1 did not receive 'Hello' from tinio2")
        console.log("FAILED")
        process.exit(1)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
}


console.log("tinio1 received 'Hello' from tinio2")

console.log("stopping tinio1")
tinio1.stop()

console.log("stopping tinio2")
tinio2.stop()

console.log("PASSED")

console.log("<<<<<<<<<<<<< End tinio testing")
