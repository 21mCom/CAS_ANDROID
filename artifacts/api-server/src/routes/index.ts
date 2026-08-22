import { Router, type IRouter } from "express";
import healthRouter from "./health";
import casRouter from "./cas";

const router: IRouter = Router();

router.use(healthRouter);
router.use(casRouter);

export default router;
