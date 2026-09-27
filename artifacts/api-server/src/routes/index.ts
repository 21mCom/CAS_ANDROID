import { Router, type IRouter } from "express";
import healthRouter from "./health";
import casRouter from "./cas";
import casConfigRouter from "./cas-config";
import casEvidenceRouter from "./cas-evidence";

const router: IRouter = Router();

router.use(healthRouter);
router.use(casRouter);
router.use(casConfigRouter);
router.use(casEvidenceRouter);

export default router;
