import net from "node:net";

const TWO_CRLF = Buffer.from("\r\n\r\n", "utf8");
const MESSAGE_TYPE = {
  notification: 0,
  request: 1,
  response: 2
};

export async function probeVerseWorkflow(config, timeoutMs = 750) {
  try {
    await openSocket(config.verseWorkflowHost, config.verseWorkflowPort, timeoutMs).then((socket) => {
      socket.destroy();
    });
    return {
      ok: true,
      host: config.verseWorkflowHost,
      port: config.verseWorkflowPort,
      protocol: "VerseWorkflowServer"
    };
  } catch (error) {
    return {
      ok: false,
      host: config.verseWorkflowHost,
      port: config.verseWorkflowPort,
      error: error instanceof Error ? error.message : String(error),
      nextStep: "Open the UEFN project and make sure the Verse workflow server is running; VS Code's official Verse extension uses the same 127.0.0.1:1962 endpoint."
    };
  }
}

export async function compileVerseViaWorkflow(config, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const socket = await openSocket(config.verseWorkflowHost, config.verseWorkflowPort, Math.min(timeoutMs, 5000));
  let rawData = Buffer.alloc(0);
  let contentLength = -1;
  let finished = false;
  let sequence = 1;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Verse workflow compileProject timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    function cleanup() {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      socket.destroy();
    }

    socket.on("data", (data) => {
      rawData = Buffer.concat([rawData, data]);
      try {
        for (const body of extractMessages()) {
          const message = JSON.parse(body);
          if (message.type !== MESSAGE_TYPE.response || message.seq !== 1 || message.command !== "compileProject") {
            continue;
          }
          cleanup();
          if (message.result !== undefined) {
            resolve({
              ok: message.result.numErrors === 0,
              source: "verse_workflow_server",
              host: config.verseWorkflowHost,
              port: config.verseWorkflowPort,
              result: message.result
            });
          } else {
            reject(new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error)));
          }
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    socket.on("error", (error) => {
      cleanup();
      reject(error);
    });

    socket.write(frameMessage({
      seq: sequence,
      type: MESSAGE_TYPE.request,
      command: "compileProject",
      params: {}
    }));

    function extractMessages() {
      const bodies = [];
      while (true) {
        if (contentLength >= 0) {
          if (rawData.length < contentLength) {
            break;
          }
          bodies.push(rawData.toString("utf8", 0, contentLength));
          rawData = rawData.subarray(contentLength);
          contentLength = -1;
          continue;
        }

        const headerEnd = rawData.indexOf(TWO_CRLF);
        if (headerEnd === -1) {
          break;
        }
        const header = rawData.toString("utf8", 0, headerEnd);
        rawData = rawData.subarray(headerEnd + TWO_CRLF.length);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          throw new Error(`Verse workflow response missing Content-Length header: ${header}`);
        }
        contentLength = Number(match[1]);
      }
      return bodies;
    }
  });
}

export function frameMessage(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function openSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

