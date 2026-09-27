import { Router, type IRouter } from "express";
import healthRouter from "./health";
import casRouter from "./cas";
import casConfigRouter from "./cas-config";

const router: IRouter = Router();

router.use(healthRouter);
router.use(casRouter);
router.use(casConfigRouter);

export default router;
