import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Network } from './network';
import { DataPipelines } from './data-pipelines/data-pipelines';

export class CoreStack extends cdk.Stack {
  public readonly network: Network;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const hostedZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(
      this, 'AnalyticsPlatformHostedZone', {
        hostedZoneId: 'Z0342334382XCESQG37FY',
        zoneName: 'analyticsplatform.co'
      }
    )
    this.network = new Network(this, "Network", { cidr: "10.0.0.0/16", hostedZone: hostedZone });
  }
}

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  subnetGroup: rds.SubnetGroup;
  listener: elbv2.ApplicationListener;
}

export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const rawDataBucket = new s3.Bucket(this, 'RawDataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const dataLakeBucket = new s3.Bucket(this, 'DataLakeBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const dataLakeDatabase = new glue.CfnDatabase(this, 'DataLakeGlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: 'datalake',
      }
    });

    new DataPipelines(this, 'Pipelines', {
      s3RawData: rawDataBucket,
      s3DataLake: dataLakeBucket,
      dataLakeDatabaseName: (dataLakeDatabase.databaseInput as glue.CfnDatabase.DatabaseInputProperty).name!,
    });
  }
}
