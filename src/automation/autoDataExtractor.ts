
import { CameraUtils } from "../utils/CameraUtils.js";
import { downloadImage } from "./helper/downloadImageWithDigestRouter.js";
import axios  from 'axios';
import path from "path";
import fs from 'fs';
import FormData from 'form-data';
import { getMonitorCoordinates } from "./helper/getMonitorCoordinates.js";

import * as dotenv from "dotenv";
import { String } from "aws-sdk/clients/batch.js";

dotenv.config({ path: "./.env" });

const MONITOR_PRESET_NAME_PREFIX = "5 Para_Bed_";

const OCR_URL:string|undefined = process.env.OCR_URL;

type ParserFunction = (value: string) => number;

type camParams ={
    useSecure:boolean,
    hostname:string,
    username?:string,
    password?:string,
    port?:number
}


const celsiusToFahrenheit = (celsius:string):number=> {
    const celsiusnum:number = parseFloat(celsius)
    const fahrenheit:number = (celsiusnum * 9/5) + 32;
    return fahrenheit;
}

const validator = (value:any, parser:ParserFunction, minvalue:number, maxValue:number):number|null=>{

    if(isNaN(value))
    {
        return null
    }

    value  = parser(value as string)

    return value >=minvalue && value <=maxValue ? value : null
}
const getSanitizedData = (data)=>{

    console.log(data)

    const sanitizedData = {}
    sanitizedData["spo2"] = !isNaN(data?.["SpO2"]) ? parseFloat(data?.["SpO2"]): null

    sanitizedData["ventilator_spo2"] = validator(sanitizedData.spo2, parseInt, 0, 100)
    
    sanitizedData["resp"] = validator(data?.["Respiratory Rate"], parseInt, 10, 70)

    sanitizedData["pulse"] = validator(data?.["Pulse Rate"], parseInt, 0, 100)

    sanitizedData["temperature"] = validator(data?.["Temperature"], celsiusToFahrenheit, 95, 106)
    
    
    sanitizedData["bp"] = !isNaN(data?.["Blood Pressure"]) ? 
    {
        "systolic": parseFloat(data?.["Blood Pressure"]),
        "mean": parseFloat(data?.["Blood Pressure"]),
        "diastolic": parseFloat(data?.["Blood Pressure"])
    } : null

    return sanitizedData


}

const extractData = async (camParams:{hostname:string,username?:string,password?:string,port?:number}, bedId:number) => {
  const coordinates = await getMonitorCoordinates(bedId);
  await CameraUtils.absoluteMove({ camParams, ...coordinates });

  const snapshotUrl:any = await CameraUtils.getSnapshotUri({ camParams });

  const fileName = "image-" + new Date().getTime() + ".jpeg";
  const imagePath = path.resolve("images", fileName);
  await downloadImage(
    snapshotUrl.uri,
    imagePath,
    camParams.username as string,
    camParams.password as string
  );
  // const testImg = path.resolve("images", "test.png")

  // POST request with image to ocr
  const bodyFormData = new FormData();
  bodyFormData.append("image", fs.createReadStream(imagePath));

  const response = await axios.post(OCR_URL as string, bodyFormData, {
    headers: {
      ...bodyFormData.getHeaders(),
    },
  });

  // delete image
  fs.unlink(imagePath, (err) => {
    if (err) {
      // TODO: Critical logger setup
      console.error(err);
    }
  });

  return getSanitizedData(response.data.data);
};



const _getCamParams = (params:{hostname:string,username?:string,password?:string,port?:number}):camParams => {
    const { hostname, username, password, port } = params;

    const camParams:camParams = {
        useSecure: Number(port) === 443,
        hostname,
        username,
        password,
        port: Number(port),
    };

    return camParams;
};

export const updateObservationAuto = async (cameraParams:{hostname:string,username?:string,password?:string,port?:number}, bedId:number) => {
  try {
    const cameraParamsSanitized:camParams = _getCamParams(cameraParams);

    const payload = await extractData(cameraParamsSanitized, bedId);

    return payload;
  } catch (err) {
    console.log(err);
    return {
      spo2: null,
      ventilator_spo2: null,
      resp: null,
      pulse: null,
      temperature: null,
      bp: null,
    };
  }
};
