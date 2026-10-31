import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`WidgetComposer API running on port ${port}`);
});

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error("Error shutting down API:", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);