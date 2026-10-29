import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";

// 用户脚本仅进入 QuickJS WebAssembly 堆；不注入任何宿主能力。
try {
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + workerData.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    const source = `(() => {
      "use strict";
      const logs = [];
      const console = Object.freeze({ log: (...args) => { if(logs.length < 30) logs.push(args.map(x => String(x)).join(' ').slice(0, 1000)); } });
      const inputs = JSON.parse(${JSON.stringify(JSON.stringify(workerData.inputs))});
      const output = (function(inputs, console) { "use strict";\n${workerData.script}\n})(inputs, console);
      if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.then === 'function') throw new Error('脚本必须同步返回输出对象，不支持 Promise');
      const result = JSON.stringify({ output, logs });
      if (result.length > 1048576) throw new Error('脚本输出超过 1 MiB');
      return result;
    })()`;
    const result = context.evalCode(source, "workflow-script.js");
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      parentPort.postMessage({
        error:
          Date.now() >= deadline
            ? "JS 脚本执行超时"
            : `JS 脚本执行错误：${String(error?.message ?? error).slice(0, 500)}`,
      });
    } else {
      const text = context.getString(result.value);
      result.value.dispose();
      parentPort.postMessage(JSON.parse(text));
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
} catch (error) {
  parentPort.postMessage({
    error: `JS 执行环境异常：${error instanceof Error ? error.message : String(error)}`,
  });
}
