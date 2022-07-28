import { BadRequestException } from "../Exception/BadRequestException.js";
import { NotFoundException } from "../Exception/NotFoundException.js";
import { catchAsync } from "../utils/catchAsync.js";
import { getAsset, getPatientId } from "../utils/dailyRoundUtils.js";
import { ObservationsMap } from "../utils/ObservationsMap.js";
import { filterClients } from "../utils/wsUtils.js";
import axios from 'axios'
import { careApi } from "../utils/configs.js";
import dayjs from "dayjs";
import { generateHeaders } from "../utils/assetUtils.js";

const DAILY_ROUND_TAG = "[Daily Round] "

var staticObservations = [];
var activeDevices = [];
var lastRequestData = {};
var logData = [];

// start updating after 2 minutes of starting the middleware
let lastUpdatedToCare = new Date() - (58 * 60 * 1000)

const DEFAULT_LISTING_LIMIT = 10;

const flattenObservations = (observations) => {
  if (Array.isArray(observations)) {
    return observations.reduce((acc, observation) => {
      return acc.concat(flattenObservations(observation));
    }, []);
  } else {
    return [observations];
  }
};

const addObservation = (observation) => {
  console.log(
    observation["date-time"],
    ": ",
    observation.device_id,
    "|",
    observation.observation_id
  );
  if (activeDevices.includes(observation.device_id)) {
    staticObservations = staticObservations.map((item) => {
      if (item.device_id === observation.device_id) {
        // Slice the observations to the last DEFAULT_LISTING_LIMIT entries
        const slicedObservations =
          item.observations[observation.observation_id]?.slice(
            -DEFAULT_LISTING_LIMIT
          ) || [];
        return {
          ...item,
          observations: {
            ...item.observations,
            [observation.observation_id]: [...slicedObservations, observation],
          },
          last_updated: new Date(),
        };
      }
      return item;
    });
  } else {
    activeDevices.push(observation.device_id);
    staticObservations = [
      ...staticObservations,
      {
        device_id: observation.device_id,
        observations: {
          [observation.observation_id]: [observation],
        },
        last_updated: new Date(),
      },
    ];
  }
};

const addLogData = (newData) => {
  // Slice the log data to the last DEFAULT_LISTING_LIMIT entries
  logData = logData.slice(logData.length - DEFAULT_LISTING_LIMIT);
  logData = [
    ...logData,
    {
      dateTime: new Date(),
      data: newData,
    },
  ];
};

const getValueFromData = (data) => {
  if (data?.status === "final") {
    return data?.value ?? null
  }
  return null
}

const updateObservationsToCare = async () => {
  console.log(DAILY_ROUND_TAG + "updateObservationsToCare called")
  const now = new Date()
  if (now - lastUpdatedToCare < 3600 * 1000) {
    // only update once per hour
    console.log(DAILY_ROUND_TAG + "updateObservationsToCare skipped")
    return
  };
  lastUpdatedToCare = now

  console.log(DAILY_ROUND_TAG + "performing daily round")
  for (const observation of staticObservations) {
    try {
      if (now - observation.last_updated > 3600 * 1000) {
        // skip if older than 1 hour
        console.log(DAILY_ROUND_TAG + "skipping stale observations for device: " + observation.device_id)
        continue
      }

      console.log(DAILY_ROUND_TAG + ">> Updating observation for device:", observation.device_id);

      const asset = await getAsset(observation.device_id);
      if (asset === null) {
        console.error(DAILY_ROUND_TAG + "Asset not found for assetIp: ", observation.device_id)
        continue
      }

      const { consultation_id, patient_id } = await getPatientId(asset.externalId);
      if (!patient_id) {
        console.error(DAILY_ROUND_TAG + "Patient not found for assetExternalId: ", asset.externalId)
        continue
      }

      const data = observation.observations

      const bp = (data["SpO2"]?.[0]?.status === "final") ? {
        systolic: data["SpO2"]?.[0]?.systolic?.value ?? null,
        diastolic: data["SpO2"]?.[0]?.diastolic?.value ?? null,
      } : null

      const temp = data["body-temperature1"]?.[0]
      let temperature = getValueFromData(temp)
      let temperature_measured_at = null
      if (temp?.["low-limit"] < temperature && temperature < temp?.["high-limit"]) {
        temperature_measured_at = dayjs(temp?.["date-time"], "YYYY-MM-DD HH:mm:ss").toISOString()
      } else {
        temperature = null
      }

      const payload = {
        taken_at: observation.last_updated,
        rounds_type: "NORMAL",
        spo2: getValueFromData(data["SpO2"]?.[0]),
        resp: getValueFromData(data["respiratory-rate"]?.[0]),
        pulse: getValueFromData(data["heart-rate"]?.[0]),
        temperature,
        temperature_measured_at
      }
      if (bp !== null && bp.systolic !== null && bp.diastolic !== null) {
        payload.bp = bp
      }

      console.log(DAILY_ROUND_TAG + "Sending payload:", payload)

      await axios.post(
        `${careApi}/api/v1/consultation/${consultation_id}/daily_rounds/`,
        payload,
        { headers: await generateHeaders(asset.externalId) }
      ).then(res => {
        console.log(res.data)
        console.log(DAILY_ROUND_TAG + "Updated observation for device:", observation.device_id);
        return res
      }).catch(err => {
        console.log(err.response.data || err.response.statusText)
        console.log(`Error performing daily round for assetIp: ${asset.ipAddress}`)
        return err.response
      })

    } catch (error) {
      console.error(DAILY_ROUND_TAG + "Error updating observations to care", error)
    }
  }
  console.log(DAILY_ROUND_TAG + "daily round finished")
}

export class ObservationController {
  // static variable to hold the latest observations

  static latestObservation = new ObservationsMap()

  static getObservations(req, res) {
    const limit = req.query?.limit || DEFAULT_LISTING_LIMIT;
    const ip = req.query?.ip;

    if (!ip) {
      return res.json(staticObservations);
    }
    // console.log("Filtering");
    const filtered = Object.values(staticObservations).reduce((acc, curr) => {
      // console.log("curr", curr);
      const latestValue = curr[ip];
      return latestValue;
    }, []);
    // Sort the observation by last updated time.
    // .sort(
    //   (a, b) => new Date(a.lastObservationAt) - new Date(b.lastObservationAt)
    // )
    // // Limit the results
    // .slice(0, limit);

    return res.json(filtered ?? []);
  }

  static getLogData(req, res) {
    return res.json(logData);
  }

  static getLastRequestData(req, res) {
    return res.json(lastRequestData);
  }

  static updateObservations = (req, res) => {
    // database logic
    lastRequestData = req.body;
    // console.log("updateObservations", req.body);
    addLogData(req.body);
    const observations = req.body;
    // If req.body.observations is an array, then we need to loop through it and create a new observation for each one
    // If req.body.observations is a single object, then we need to create a new observation for it
    // If req.body.observations is undefined, then we need to return an error
    // If req.body.observations is not an array or object, then we need to return an error
    if (!observations)
      throw new BadRequestException("No observations provided");

    if (typeof observations !== "object")
      throw new BadRequestException("Invalid observations provided");

    const flattenedObservations = flattenObservations(observations);

    this.latestObservation.set(flattenedObservations)

    filterClients(req.wsInstance.getWss(), "/observations").forEach(
      (client) => {
        const filteredObservations = flattenedObservations?.filter(
          (observation) => observation?.device_id === client?.params?.ip
        );
        if (filteredObservations.length) {
          client.send(JSON.stringify(filteredObservations));
        }
      }
    );

    flattenedObservations.forEach((observation) => {
      addObservation(observation);
    });

    updateObservationsToCare()

    return res.send(req.body);
  }

  static getTime = async (req, res) => {
    res.send({
      time: new Date().toISOString(),
    });
  };

  static getLatestVitals = catchAsync(async (req, res) => {
    const { device_id } = req.query
    const data = this.latestObservation.get(device_id)

    if (!data) throw new NotFoundException(`No data found with device id ${device_id}`)

    res.send({
      status: "success",
      data
    })
  })
}
