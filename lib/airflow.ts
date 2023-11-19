import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as asg from 'aws-cdk-lib/aws-autoscaling';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration } from 'aws-cdk-lib';

import { Construct } from 'constructs';

export interface AirflowProps {
  vpc: ec2.Vpc;
  subnetGroup: rds.SubnetGroup;
  fernetSecret: secretsmanager.ISecret;
  dockerhubSecret: secretsmanager.ISecret;
  //applicationLoadBalancer: elbv2.ApplicationLoadBalancer;
}

export class Airflow extends Construct {
  constructor(scope: Construct, id: string, props: AirflowProps) {
    super(scope, id)

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc: props.vpc,
      description: 'Used by the Airflow Database',
      allowAllOutbound: true
    });

    // Allow inbound traffic on port 5432 from within the VPC
    // TODO: Update to only allow Airflow
    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL traffic from within the VPC'
    );

    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15_4 });
    const rdsInstance = new rds.DatabaseInstance(this, 'Database', {
      engine,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO
      ),
      vpc: props.vpc,
      securityGroups: [dbSecurityGroup],
      subnetGroup: props.subnetGroup,
      multiAz: false,
      allocatedStorage: 20,
      deleteAutomatedBackups: true,
      deletionProtection: false,
      databaseName: 'airflow',
      enablePerformanceInsights: true,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      caCertificate: rds.CaCertificate.RDS_CA_RDS2048_G1,
      backupRetention: Duration.days(7),
    });

    const autoScalingGroup = new asg.AutoScalingGroup(this, 'Airflow', {
      vpc: props.vpc,
      instanceType: new ec2.InstanceType('t4g.small'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.ARM),
      minCapacity: 1,
      maxCapacity: 1
    });

    const cluster = new ecs.Cluster(this, 'AiflowCluster', {
      vpc: props.vpc,
      clusterName: 'Airflow',
      containerInsights: true
    });

    const airflowCredentialsSecret = new secretsmanager.Secret(this, 'AirflowAdminSecret', {
      description: 'Administrator credentials for Airflow',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        passwordLength: 16,
        generateStringKey: 'password',
        excludePunctuation: true
      },
    });

    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'AirflowTaskDefinition');

    const airflowSchedulerContainer = taskDefinition.addContainer('AirflowSchedulerContainer', {
      image: ecs.ContainerImage.fromRegistry(
        'apache/airflow:2.7.3', { credentials: props.dockerhubSecret }
      ),
      memoryLimitMiB: 1536,
      environment: {
        'AIRFLOW__CORE__EXECUTOR': 'LocalExecutor',
        'AIRFLOW__DATABASE__SQL_ALCHEMY_CONN_CMD': 'echo postgresql+psycopg2://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}/airflow',
        'AIRFLOW__CORE__LOAD_EXAMPLES': 'True'
      },
      secrets: {
        'AIRFLOW__CORE__FERNET_KEY': ecs.Secret.fromSecretsManager(props.fernetSecret),
        'DB_HOST': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'host'),
        'DB_USERNAME': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'username'),
        'DB_PASSWORD': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'password')
      },
      command: ["scheduler"]
    });
  }
}
