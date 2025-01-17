import {
  autoObservationValidator,
  observationsValidators,
  vitalsValidator,
} from "../Validators/observationValidators.js";

import { ObservationController } from "../controller/ObservationController.js";
import express from "express";
import { validate } from "../middleware/validate.js";

const router = express.Router();

router.get("/get_observations", ObservationController.getObservations);

router.post(
  "/update_observations",
  validate(observationsValidators),
  ObservationController.updateObservations
);

router.get(
  "/vitals",
  validate(vitalsValidator),
  ObservationController.getLatestVitals
);

router.get("/get_time", ObservationController.getTime);

router.get("/devices/status", ObservationController.status);

// Debugging Endpoints

router.get("/get_log_data", ObservationController.getLogData);

router.get("/get_last_request_data", ObservationController.getLastRequestData);

export { router as observationRouter };