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

    const httpCallLambdaVersion = httpCallLambda.currentVersion;
    const httpCallLambdaAlias = new lambda.Alias(this, 'HttpCallLambdaAlias', {
      aliasName: 'Current',
      version: httpCallLambdaVersion,
      provisionedConcurrentExecutions: 0,
    });

    const cfnScheduleGroup = new scheduler.CfnScheduleGroup(this, 'DataPipelinesScheduleGroup', {
      name: 'data-pipelines',
    });

    new Pipeline(this, 'DitTradeBarriers', {
      datasetProvider: 'dit',
      datasetName: 'trade-barriers',
      datasetType: 'json',
      scheduleExpression: "cron(0 */4 * * ? *)",
      s3RawData: props.s3RawData,
      s3DataLake: props.s3DataLake,
      dataLakeDatabaseName: props.dataLakeDatabaseName,
      extractLambda: httpCallLambdaAlias,
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

    new Pipeline(this, 'EnvironmentAgencyFloods', {
      datasetProvider: 'Environment-Agency',
      datasetName: 'Floods',
      datasetType: 'json',
      scheduleExpression: "cron(*/30 * * * ? *)",
      s3RawData: props.s3RawData,
      s3DataLake: props.s3DataLake,
      dataLakeDatabaseName: props.dataLakeDatabaseName,
      extractLambda: httpCallLambdaAlias,
      scheduleGroupName: cfnScheduleGroup.name!,
      extractConfig: {
        url: 'https://environment.data.gov.uk/flood-monitoring/id/floods',
      },
      transformLoadConfig: {
        path: path.join(__dirname, 'files/ea-floods-tl'),
        handler: 'main.handler',
        layerArns: ['arn:aws:lambda:eu-west-2:336392948345:layer:AWSSDKPandas-Python311-Arm64:4']
      },
    });

    new Pipeline(this, 'NhsUecSitrep', {
      datasetProvider: 'NHS',
      datasetName: 'UEC-Sitrep',
      datasetType: 'xlsx',
      scheduleExpression: "cron(45 9 ? * FRI *)",
      s3RawData: props.s3RawData,
      s3DataLake: props.s3DataLake,
      dataLakeDatabaseName: props.dataLakeDatabaseName,
      extractLambda: httpCallLambdaAlias,
      scheduleGroupName: cfnScheduleGroup.name!,
      extractConfig: {
        url: 'https://www.england.nhs.uk/statistics/wp-content/uploads/sites/2/2023/12/Web-File-Timeseries-UEC-Daily-SitRep-2.xlsx',
      },
      transformLoadConfig: {
        path: path.join(__dirname, 'files/nhs-uec-sitrep-tl'),
        handler: 'main.handler',
        layerArns: ['arn:aws:lambda:eu-west-2:336392948345:layer:AWSSDKPandas-Python311-Arm64:4']
      },
    });
  }
}
