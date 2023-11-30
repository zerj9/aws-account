import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as asg from 'aws-cdk-lib/aws-autoscaling';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration } from 'aws-cdk-lib';

import { Construct } from 'constructs';

export interface AirflowProps {
  vpc: ec2.Vpc;
  subnetGroup: rds.SubnetGroup;
  fernetSecret: secretsmanager.ISecret;
  dockerhubSecret: secretsmanager.ISecret;
  listener: elbv2.ApplicationListener;
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

//    const ecsInstanceSecurityGroup = new ec2.SecurityGroup(this, 'EcsInstanceSecurityGroup', {
//      vpc: props.vpc,
//      description: 'Used by the Airflow ECS Instance',
//      allowAllOutbound: true
//    });

    const autoScalingGroup = new asg.AutoScalingGroup(this, 'Airflow', {
      vpc: props.vpc,
      instanceType: new ec2.InstanceType('t4g.small'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.ARM),
      minCapacity: 1,
      maxCapacity: 1
    });

    const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup,
    });

    const cluster = new ecs.Cluster(this, 'AiflowCluster', {
      vpc: props.vpc,
      clusterName: 'Airflow',
      containerInsights: true
    });
    cluster.addAsgCapacityProvider(capacityProvider);

    const airflowCredentialsSecret = new secretsmanager.Secret(this, 'AirflowAdminSecret', {
      description: 'Administrator credentials for Airflow',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        passwordLength: 16,
        generateStringKey: 'password',
        excludePunctuation: true
      },
    });

    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'AirflowTaskDefinition', {
      networkMode: ecs.NetworkMode.AWS_VPC
    });

    const schedulerContainer = taskDefinition.addContainer('AirflowSchedulerContainer', {
      image: ecs.ContainerImage.fromRegistry(
        'apache/airflow:2.7.3', { credentials: props.dockerhubSecret }
      ),
      memoryLimitMiB: 900,
      environment: {
        '_AIRFLOW_DB_MIGRATE': 'true',
        '_AIRFLOW_WWW_USER_CREATE': 'true',
        'AIRFLOW__CORE__EXECUTOR': 'LocalExecutor',
        'AIRFLOW__DATABASE__SQL_ALCHEMY_CONN': 'postgresql+psycopg2://$DB_USERNAME:$DB_PASSWORD@$DB_HOST/airflow',
        'AIRFLOW__CORE__LOAD_EXAMPLES': 'True'
      },
      secrets: {
        '_AIRFLOW_WWW_USER_USERNAME': ecs.Secret.fromSecretsManager(airflowCredentialsSecret, 'username'),
        '_AIRFLOW_WWW_USER_PASSWORD': ecs.Secret.fromSecretsManager(airflowCredentialsSecret, 'password'),
        'AIRFLOW__CORE__FERNET_KEY': ecs.Secret.fromSecretsManager(props.fernetSecret),
        'DB_HOST': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'host'),
        'DB_USERNAME': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'username'),
        'DB_PASSWORD': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'scheduler',
        logRetention: logs.RetentionDays.THREE_MONTHS,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: cdk.Size.mebibytes(25),
      }),
      command: ["scheduler"],
      healthCheck: {
        command: [ "CMD-SHELL", "airflow jobs check --job-type SchedulerJob" ],
        interval: Duration.minutes(1),
        retries: 3,
        startPeriod: Duration.minutes(2),
        timeout: Duration.seconds(30),
      }
    });

   const webServerContainer = taskDefinition.addContainer('AirflowWebServerContainer', {
      image: ecs.ContainerImage.fromRegistry(
        'apache/airflow:2.7.3', { credentials: props.dockerhubSecret }
      ),
      memoryLimitMiB: 900,
      environment: {
        '_AIRFLOW_DB_MIGRATE': 'true',
        '_AIRFLOW_WWW_USER_CREATE': 'true',
        'AIRFLOW__CORE__EXECUTOR': 'LocalExecutor',
        'AIRFLOW__DATABASE__SQL_ALCHEMY_CONN': 'postgresql+psycopg2://$DB_USERNAME:$DB_PASSWORD@$DB_HOST/airflow',
        'AIRFLOW__CORE__LOAD_EXAMPLES': 'True',
        'FORWARDED_ALLOW_IPS': '*'
      },
      secrets: {
        '_AIRFLOW_WWW_USER_USERNAME': ecs.Secret.fromSecretsManager(airflowCredentialsSecret, 'username'),
        '_AIRFLOW_WWW_USER_PASSWORD': ecs.Secret.fromSecretsManager(airflowCredentialsSecret, 'password'),
        'AIRFLOW__CORE__FERNET_KEY': ecs.Secret.fromSecretsManager(props.fernetSecret),
        'DB_HOST': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'host'),
        'DB_USERNAME': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'username'),
        'DB_PASSWORD': ecs.Secret.fromSecretsManager(rdsInstance.secret!, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'webserver',
        logRetention: logs.RetentionDays.THREE_MONTHS,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: cdk.Size.mebibytes(25),
      }),
      command: ["webserver"]
    });

    webServerContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    const schedulerDependency: ecs.ContainerDependency = {
      container: schedulerContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    };
    webServerContainer.addContainerDependencies(schedulerDependency);
    taskDefinition.defaultContainer = webServerContainer

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'AirflowServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'Used by the Airflow ECS Service',
      allowAllOutbound: true
    });
    serviceSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(8080),
      'Allow 8080 traffic from within the VPC' // Change this to only allow ALB
    );

    const ecsService = new ecs.Ec2Service(this, 'AirflowService', {
      cluster,
      taskDefinition,
      enableExecuteCommand: true,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup]
    });

//    props.listener.addTargets('AirflowListenerTargets', {
//      priority: 10,
//      port: 8080,
//      conditions: [elbv2.ListenerCondition.hostHeaders(['airflow.analyticsplatform.co'])],
//      targets: [ecsService]
//    });
  }
}
