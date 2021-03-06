import * as fs from 'fs'
import * as http from 'http'
import { compile } from 'mistc'
import * as path from 'path'
import * as request from 'request'
import * as vscode from 'vscode'
import { commands, ExtensionContext } from 'vscode'
import { isMistFile } from './previewProvider'

export let stopServerFunc: () => void

enum CommandContext {
  IsDebugging = 'mist:isDebugging'
}

function setCommandContext(key: CommandContext | string, value: any) {
  return commands.executeCommand('setContext', key, value)
}

export function registerMistServer(context: ExtensionContext) {
  registerServer(context)
  registerPushService(context)
}

function registerServer(context: ExtensionContext) {
  let server: http.Server
  let clientAddress: string
  let output: vscode.OutputChannel
  setCommandContext(CommandContext.IsDebugging, false)
  context.subscriptions.push(
    commands.registerCommand('mist.startServer', (uri) => {
      if (server) {
        return
      }
      let workingDir = vscode.workspace.rootPath
      if (!workingDir) {
        vscode.window.showErrorMessage('未打开文件夹')
        return
      }

      let serverPort = 10001
      server = http.createServer(async (req, res) => {
        clientAddress = req.connection.remoteAddress
        output.appendLine(`> ${req.method}\t${req.url}`)

        const file = path.join(workingDir, req.url)
        try {
          if (!fs.existsSync(file)) {
            throw new Error('file not exists')
          }

          let content: string
          if (path.extname(file) === '.mist') {
            content = await compile(file, { platform: 'ios', debug: true })
          } else if (path.extname(file) === '.png') {
            fs.readFile(file, 'binary', function(err, file) {
              if (err) {
                console.log(err)
                return
              } else {
                res.writeHead(200, { 'Content-Type': 'image/png' })
                res.write(file, 'binary')
                res.end()
              }
            })
            return
          } else {
            content = fs.readFileSync(file, 'utf-8')
          }

          res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8' })
          res.end(content)
        } catch (e) {
          res.writeHead(404)
          res.end()
        }
      })

      server.once('error', (err) => {
        server = null
        let errMsg: string
        if ((err as any).code === 'EADDRINUSE') {
          errMsg = 'Port 10001 already in use. Use <lsof -i tcp:10001> then <kill $PID> to free.'
        } else {
          errMsg = 'Failed to start server. ' + err.message
        }
        vscode.window.showErrorMessage(errMsg)
      })

      server.listen(serverPort, '0.0.0.0', function() {
        setCommandContext(CommandContext.IsDebugging, true)
        output = vscode.window.createOutputChannel('Mist Debug Server')
        output.show()
        output.appendLine(`> Start mist debug server at 127.0.0.1:${serverPort}`)
      })
    })
  )

  context.subscriptions.push(
    commands.registerCommand('mist.stopServer', (uri) => {
      stopServer()
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      let validFormat = isMistFile(document) || document.uri.path.endsWith('.json')
      if (!validFormat || !server) {
        return
      }
      let clientPort = 10002
      let options = {
        hostname: clientAddress || '0.0.0.0',
        port: clientPort,
        method: 'GET',
        path: '/refresh'
      }
      const req = http.request(options, null)
      req.on('error', (e) => {
        console.log(`SIMULATOR NOT RESPONSE: ${e.message}\n`)
      })
      req.end()
    })
  )

  function stopServer() {
    if (server) {
      server.close()
      server = null
    }
    if (output) {
      output.clear()
      output.hide()
      output.dispose()
      output = null
    }
    if (vscode.workspace.rootPath) {
      return setCommandContext(CommandContext.IsDebugging, false)
    }
  }
  stopServerFunc = stopServer
}

function readFiles(path: string) {
  return new Promise<string[]>((resolve) => {
    fs.readdir(path, (err, files) => {
      resolve(files)
    })
  })
}

async function openEditor(path: string) {
  const exists = fs.existsSync(path)
  let doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${exists ? 'file://' : 'untitled:'}${path}`))
  vscode.window.showTextDocument(doc)
}

async function insertInEditor(path: string, name: string) {
  const exists = fs.existsSync(path)
  let doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${exists ? 'file://' : 'untitled:'}${path}`))
  let editor = await vscode.window.showTextDocument(doc)
  let value = exists ? `"${name}": "$0",` : `{"${name}": "$0"}`
  editor.insertSnippet(new vscode.SnippetString(value), new vscode.Position(0, 1))
}

function registerPushService(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand('mist.debugAndroid', (args) => {
      // push current file to Android
      require('child_process').exec('adb shell ip route', async function(error, stdout, stderr) {
        let deviceIp
        let ptr = stdout.indexOf('scope link  src ')
        if (ptr > 0) {
          ptr = ptr + 'scope link  src '.length
          deviceIp = stdout.substr(ptr).trim()
        }

        let fileUri = vscode.window.activeTextEditor.document.uri
        let mistFile = fileUri.toString().substring(7)
        let mistPath = path.parse(mistFile)
        let configFile = mistPath.dir + '/config.json'

        if (!fs.existsSync(configFile)) {
          vscode.window.showErrorMessage('请配置业务前缀bizCode并保存。')
          insertInEditor(configFile, 'bizCode')
          return
        }

        let config
        try {
          config = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
        } catch (e) {
          openEditor(configFile)
          vscode.window.showErrorMessage('请确保config.json文件内容格式为JSON。')
          return
        }

        let bizCode = config.bizCode
        if (!bizCode) {
          vscode.window.showErrorMessage('请配置业务前缀bizCode并保存。')
          insertInEditor(configFile, 'bizCode')
          return
        }

        if (!deviceIp) {
          deviceIp = config.deviceIp
        }
        if (!deviceIp) {
          vscode.window.showErrorMessage('请配置设备IP地址或者连接ADB。')
          insertInEditor(configFile, 'deviceIp')
          return
        }

        console.log('mist file: ' + mistFile)
        console.log('deviceIp: ' + deviceIp)
        console.log('bizCode:' + bizCode)

        let templateContent
        try {
          templateContent = await compile(mistFile, { minify: true, platform: 'android', debug: true })
        } catch (e) {
          vscode.window.showErrorMessage('模板编译错误：' + e.message)
          return
        }

        const imagesDir = mistPath.dir + '/Images'
        let images = await readFiles(imagesDir)

        const formData = {}
        formData['templateName'] = config.bizCode + '@' + mistPath.name
        formData['templateHtml'] = templateContent
        if (images && images.length > 0) {
          for (let image of images) {
            let imagePath = imagesDir + '/' + image
            console.log('Upload file: ' + imagePath)
            formData[image] = {
              value: fs.createReadStream(imagePath),
              options: {
                filename: image
              }
            }
          }
        }

        const devicePort = config.devicePort
        request.post(
          {
            url: `http://${deviceIp}:${devicePort ? parseInt(devicePort) : 9012}/update`,
            headers: {
              'Content-Type': 'multipart/form-data'
            },
            formData: formData
          },
          (err, res, data) => {
            console.log('Error: ' + err)
            console.log('Data: ' + data)
            if (err) {
              vscode.window.showErrorMessage('请求手机失败：' + err)
            } else if (data) {
              data = JSON.parse(data)
              if (data.success == true) {
                vscode.window.showInformationMessage('模板已传输到手机.')
              } else if (data.message) {
                vscode.window.showErrorMessage('传输模板到手机失败：' + data.message)
              }
            } else {
              vscode.window.showErrorMessage('传输模板到手机失败: 未知错误!')
            }
          }
        )
      })
    })
  )
}
