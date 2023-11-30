import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

export interface NetworkProps {
  cidr: string;
  hostedZone: route53.IPublicHostedZone;
}

export class Network extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly subnetGroup: rds.SubnetGroup; 
  public readonly httpsListener: elbv2.ApplicationListener; 

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    this.subnetGroup = new rds.SubnetGroup(this, 'SubnetGroupAll', {
      vpc: this.vpc,
      description: 'Subnet Group with all subnets',
      vpcSubnets: {
        subnets: this.vpc.publicSubnets
      }
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.hostedZone.zoneName,
      subjectAlternativeNames: [`*.${props.hostedZone.zoneName}`],
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
      vpc: this.vpc,
      internetFacing: true
    });

    alb.addListener('Listener80', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      })
    });

    this.httpsListener = alb.addListener('Listener443', {
      port: 443,
      certificates: [certificate],
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(404)
    });

    new route53.ARecord(this, 'Route53AlbRecord', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb))
    })

    new route53.ARecord(this, 'Route53AlbRecordSubDomain', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
      recordName: '*'
    })

  }
}
