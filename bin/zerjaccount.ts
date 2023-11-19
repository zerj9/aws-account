#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CoreStack, DataStack } from '../lib/stacks';

const prod  = { account: '314492765508', region: 'eu-west-2' };

const app = new cdk.App();
const coreStackProd = new CoreStack(app, 'CoreStackProd', { env: prod });
new DataStack(app, 'DataStackProd', { env: prod, vpc: coreStackProd.network.vpc, subnetGroup: coreStackProd.network.subnetGroup});
