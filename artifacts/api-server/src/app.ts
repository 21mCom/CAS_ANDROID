import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Bounded to the maximum supported Gate 0A hardware-run report (a real Pixel
// run with the default 200-repeat series is ~250 KB) with headroom; the web
// importer in artifacts/covert-alert-system/src/pages/gates.tsx enforces the
// same 512 KB bound before uploading.
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
