const fs = require("node:fs");
exports.activate = (context) => {
  if (process.env.VRATA_HOST_PHASE && process.env.VRATA_HOST_RESULT) {
    setTimeout(async () => {
      let result;
      try {
        result = { passed: true, ...(await require("../host.cjs").run()) };
      } catch (error) {
        result = {
          passed: false,
          phase: process.env.VRATA_HOST_PHASE,
          error: error instanceof Error ? error.message : "Host test failed",
        };
      }
      fs.writeFileSync(process.env.VRATA_HOST_RESULT, JSON.stringify(result));
      await require("vscode").commands.executeCommand("workbench.action.quit");
    }, 0);
  }
  return { secrets: context.secrets };
};
