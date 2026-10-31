import { Router } from "express"
import { upload } from "../middlewares/upload.middleware.js";
import { chartData, importUniversalMeasurement } from "../controllers/measurement.controller.js";

const router = Router()

router.post('/import-universal-measurement/:boardId', upload.single('file'), importUniversalMeasurement)
router.get('/chart-data/:boardId', chartData)

export default router;