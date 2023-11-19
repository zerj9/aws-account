import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Network } from './network';
import { Airflow } from './airflow';

export class CoreStack extends cdk.Stack {
  public readonly network: Network;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.network = new Network(this, "Network", { cidr: "10.0.0.0/16" });
  }
}

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  subnetGroup: rds.SubnetGroup;
}

export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    new Airflow(this, "Airflow", {
      vpc: props.vpc,
      subnetGroup: props.subnetGroup,
      fernetSecret: secretsmanager.Secret.fromSecretNameV2(this, 'AirflowFernetSecret', 'AirflowFernetSecret'),
      dockerhubSecret: secretsmanager.Secret.fromSecretNameV2(this, 'DockerHubSecret', 'DockerHub')
    });
  }
}
