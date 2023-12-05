import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration } from 'aws-cdk-lib';

import { Construct } from 'constructs';

export interface AirflowProps {
  vpc: ec2.IVpc;
  subnetGroup: rds.ISubnetGroup;
  fernetSecret: secretsmanager.ISecret;
  dockerhubSecret: secretsmanager.ISecret;
  listener: elbv2.ApplicationListener;
  gitSync?: {
    repo: string
    patSecret: secretsmanager.ISecret
  };
  s3RawData?: s3.IBucket;
  s3DataLake?: s3.IBucket;
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


    const airflowCredentialsSecret = new secretsmanager.Secret(this, 'AirflowAdminSecret', {
      description: 'Administrator credentials for Airflow',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        passwordLength: 16,
        generateStringKey: 'password',
        excludePunctuation: true
      },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'AirflowTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 2048
    });
    taskDefinition.addVolume({ name: 'airflow-dags' });

    if (props.s3RawData) {
      taskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:Put*', 's3:Get*', 's3:List*', 's3:Delete*'],
          resources: [`${props.s3RawData.bucketArn}/*`],
        })
      );
    }

    if (props.s3DataLake) {
      taskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:Put*', 's3:Get*', 's3:List*'],
          resources: [`${props.s3DataLake.bucketArn}/*`],
        })
      );
    }

    const schedulerContainer = taskDefinition.addContainer('AirflowSchedulerContainer', {
      image: ecs.ContainerImage.fromRegistry(
        'apache/airflow:2.7.3', { credentials: props.dockerhubSecret }
      ),
      memoryLimitMiB: 900,
      environment: {
        '_AIRFLOW_DB_MIGRATE': 'true',
        '_AIRFLOW_WWW_USER_CREATE': 'true',
        'AIRFLOW__CORE__EXECUTOR': 'LocalExecutor',
        'AIRFLOW__CORE__DAGS_FOLDER': '/home/airflow/dags',
        'AIRFLOW__DATABASE__SQL_ALCHEMY_CONN': 'postgresql+psycopg2://$DB_USERNAME:$DB_PASSWORD@$DB_HOST/airflow',
        'AIRFLOW__CORE__LOAD_EXAMPLES': 'False',
        '_PIP_ADDITIONAL_REQUIREMENTS': 'awswrangler',
          ...(props.s3RawData && {AIRFLOW_VAR_S3_RAW_BUCKET: props.s3RawData.bucketName}),
          ...(props.s3DataLake && {AIRFLOW_VAR_S3_DATA_LAKE_BUCKET: props.s3DataLake.bucketName}),

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
        retries: 10,
        startPeriod: Duration.minutes(2),
        timeout: Duration.seconds(30),
      }
    });
    schedulerContainer.addMountPoints({ sourceVolume: 'airflow-dags', readOnly: false, containerPath: '/home/airflow/dags' });

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
        'AIRFLOW__CORE__LOAD_EXAMPLES': 'False',
        'AIRFLOW__WEBSERVER__EXPOSE_CONFIG': 'True',
        'FORWARDED_ALLOW_IPS': '*',
        ...(props.s3RawData && {AIRFLOW_VAR_S3_RAW_BUCKET: props.s3RawData.bucketName}),
        ...(props.s3DataLake && {AIRFLOW_VAR_S3_DATA_LAKE_BUCKET: props.s3DataLake.bucketName}),
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
      name: 'airflow-web-server',
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    if (props.gitSync != null) {
      const gitSyncContainer = taskDefinition.addContainer('GitSyncContainer', {
        image: ecs.ContainerImage.fromRegistry(
          'alpine:3.18', { credentials: props.dockerhubSecret }
        ),
        memoryLimitMiB: 50,
        environment: {
          'GITHUB_REPO': 'zerj9/airflow-dags'
        },
        secrets: {
          'GITHUB_PAT': ecs.Secret.fromSecretsManager(props.gitSync.patSecret),
        },
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'gitsync',
          logRetention: logs.RetentionDays.THREE_MONTHS,
          mode: ecs.AwsLogDriverMode.NON_BLOCKING,
          maxBufferSize: cdk.Size.mebibytes(25),
        }),
        entryPoint: ['/bin/sh', '-c'],
        command: ['apk add --no-cache git; git clone --depth 1 https://$GITHUB_PAT@github.com/$GITHUB_REPO ~/dags; while true; do cd ~/dags && git pull; sleep 10; done']
      })
      gitSyncContainer.addMountPoints({ sourceVolume: 'airflow-dags', readOnly: false, containerPath: '/root/dags'});
    } else {
      console.log("NO SYNC")
    }

    const schedulerDependency: ecs.ContainerDependency = {
      container: schedulerContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    };
    webServerContainer.addContainerDependencies(schedulerDependency);
    taskDefinition.defaultContainer = webServerContainer

    const ecsCluster = new ecs.Cluster(this, 'AiflowCluster', {
      vpc: props.vpc,
      clusterName: 'Airflow',
      containerInsights: true
    });

    const ecsService = new ecs.FargateService(this, 'AirflowService', {
      cluster: ecsCluster,
      taskDefinition,
      enableExecuteCommand: true,
      assignPublicIp: true,
      healthCheckGracePeriod: Duration.minutes(5)
    });

    props.listener.addTargets('AirflowListenerTargets', {
      priority: 10,
      port: taskDefinition.defaultContainer.portMappings[0].containerPort,
      conditions: [elbv2.ListenerCondition.hostHeaders(['airflow.analyticsplatform.co'])],
      targets: [ecsService.loadBalancerTarget({containerName: 'AirflowWebServerContainer', containerPort: 8080})],
      healthCheck: { path: '/health', healthyHttpCodes: '200-299', healthyThresholdCount: 2, unhealthyThresholdCount: 10  }
    });
  }
}
