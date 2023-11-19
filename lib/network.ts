import { Construct } from 'constructs';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface NetworkProps {
  cidr: string;
}

export class Network extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly subnetGroup: rds.SubnetGroup; 
  public readonly alb: elbv2.ApplicationLoadBalancer; 

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

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
      vpc: this.vpc,
      internetFacing: true
    });
  }
}
