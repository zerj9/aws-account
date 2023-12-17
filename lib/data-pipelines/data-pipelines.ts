import * as path from 'path'
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { Construct } from 'constructs';
import Pipeline from './pipeline';


export interface DataPipelinesProps {
  s3RawData: s3.IBucket;
  s3DataLake: s3.IBucket;
  dataLakeDatabaseName: string;
}


export class DataPipelines extends Construct {
  constructor(scope: Construct, id: string, props: DataPipelinesProps) {
    super(scope, id)
    const httpCallLambda = new lambda.Function(this, 'HttpCallLambdaFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'http_call.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'files/http-call')),
      architecture: lambda.Architecture.ARM_64,
    });
    props.s3RawData.grantWrite(httpCallLambda);

    const cfnScheduleGroup = new scheduler.CfnScheduleGroup(this, 'DataPipelinesScheduleGroup', {
      name: 'data-pipelines',
    });

    new Pipeline(this, 'DitTradeBarriers', {
      datasetProvider: 'dit',
      datasetName: 'trade-barriers',
      datasetType: 'json',
      scheduleExpression: "cron(0 * * * ? *)", // Every hour
      s3RawData: props.s3RawData,
      s3DataLake: props.s3DataLake,
      dataLakeDatabaseName: props.dataLakeDatabaseName,
      extractLambda: httpCallLambda,
      scheduleGroupName: cfnScheduleGroup.name!,
      extractConfig: {
        url: 'https://data.api.trade.gov.uk/v1/datasets/market-barriers/versions/v1.0.10/data?format=json',
      },
      transformLoadConfig: {
        path: path.join(__dirname, 'files/dit-trade-barriers-tl'),
        handler: 'main.handler',
        layerArns: ['arn:aws:lambda:eu-west-2:336392948345:layer:AWSSDKPandas-Python311-Arm64:4']
      },
    });
  }
}