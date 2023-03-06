import fs from 'node:fs'
import process from 'node:process'
import url from "node:url"
import path from "node:path"

type TestFunc = ()=>Promise<boolean>
type ModuleExport = {testers:{[key:string]:TestFunc}}

async function main(){
    const root_path = path.dirname(url.fileURLToPath(import.meta.url))
    const testers:Array<{name:string, func:TestFunc}> = []
    const units = fs.readdirSync(root_path + "/units")
    const modfiles:Array<string> = []
    units.forEach(async (u: string)=>{
        if (u.substring(u.length - 3).toLowerCase() == '.js'){
            const path = `${root_path}/units/${u}`
            modfiles.push(path)
        }
    })
    for(let f of modfiles){
        const t:ModuleExport = (await import(f)) as ModuleExport
        if(t && t.testers){
            for(let test in t.testers){
                testers.push({name:test, func:t.testers[test]})
            }
        }
    }

    let faultCount = 0
    for(let i = 0; i < testers.length; ++i){
        const test = testers[i]
        console.log(`Test [${i+1}/${testers.length}] ${test.name} started.`)
        const v = test.func
        let ret = false
        try{
            ret = await v()
            console.log(`Test [${i+1}/${testers.length}] ${test.name} passed.`)
        }catch(e){
            console.log(`Test [${i+1}/${testers.length}] ${test.name} failed: `, e)
            faultCount++
        } 
    }

    console.log(`Test Job Finished.`)
    console.log(`Total: ${testers.length}, ${testers.length - faultCount} Passed,  ${faultCount} Failed`)
    if(faultCount){
        console.log(`Test Job Failed.`)
        process.exit(1)
    }else{
        console.log(`Test Job Passed.`)
        process.exit(0)
    }
}

await main();