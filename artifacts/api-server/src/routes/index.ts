import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import productsRouter from "./products.js";
import inventoryRouter from "./inventory.js";
import ordersRouter from "./orders.js";
import statsRouter from "./stats.js";
import botUsersRouter from "./botUsers.js";
import syncRouter from "./sync.js";
import gcmmoAuthRouter from "./gcmmo-auth.js";
import gcmmoBrowserAuthRouter from "./gcmmo-browser-auth.js";
import settingsRouter from "./settings.js";
import walletRouter from "./wallet.js";
import sellersRouter from "./sellers.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(productsRouter);
router.use(inventoryRouter);
router.use(ordersRouter);
router.use(statsRouter);
router.use(botUsersRouter);
router.use(syncRouter);
router.use("/gcmmo-auth", gcmmoAuthRouter);
router.use("/gcmmo-browser-auth", gcmmoBrowserAuthRouter);
router.use(settingsRouter);
router.use(walletRouter);
router.use(sellersRouter);

export default router;
