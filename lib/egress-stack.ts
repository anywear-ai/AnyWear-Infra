import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { BASE_EXPORTS } from './base-exports';

// Issue #166: the Egress stack is the disposable network edge of Beta. It holds
// only the paid, recreatable egress resources, so stopping Beta is deleting this
// stack and the Infra-owned Runtime stack while the Base stack (VPC, subnets,
// route tables/associations, Aurora, S3, Cognito, ECR, SQS, SSM, CloudFront)
// stays untouched.
//
// Route tables and associations are Base-owned: AWS allows one association per
// subnet and Base already creates it. Egress imports the Base VPC id, the NAT
// placement subnet and each Base private route-table id through the explicit
// CloudFormation exports in `base-exports.ts`, then adds only the 0.0.0.0/0
// routes into those tables. Deleting Egress removes the routes (and the NAT,
// EIP and S3 gateway endpoint), returning the same Private subnets to the
// isolated state without a Base update. There is no second association and no
// new stage-contract parameter.
//
// The imports are ordinary same-account CloudFormation exports; Egress synthesis
// needs no Base stack object and no Service artifact directory.
export const EGRESS_STACK_NAME = 'AnyWearEgressStack-beta';

export class EgressStack extends cdk.Stack {
  readonly natEip: ec2.CfnEIP;
  readonly natGateway: ec2.CfnNatGateway;
  readonly defaultRoutes: ec2.CfnRoute[];
  readonly s3GatewayEndpoint: ec2.CfnVPCEndpoint;

  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    const importBase = (exportName: string): string => cdk.Fn.importValue(exportName);
    const vpcId = importBase(BASE_EXPORTS.vpcId);

    // The stack owns the EIP and releases it with the stack. A stop therefore
    // leaves no idle allocation behind and a start allocates a fresh one, so the
    // outbound source address changes on every start. That is the accepted trade
    // for an edge whose stopped state costs nothing and whose address can never
    // accumulate: an idle EIP is billed while it exists, and a retained address
    // has to be carried by hand between a stop and the next start.
    this.natEip = new ec2.CfnEIP(this, 'NatEipNext', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: 'beta-anywear-egress-nat' }],
    });
    this.natGateway = new ec2.CfnNatGateway(this, 'NatGatewayNext', {
      allocationId: this.natEip.attrAllocationId,
      subnetId: importBase(BASE_EXPORTS.natSubnetId),
      connectivityType: 'public',
      tags: [{ key: 'Name', value: 'beta-anywear-egress-nat' }],
    });

    // One default route per Base-owned private route table. No route table, no
    // subnet route-table association and no subnet is created here.
    this.defaultRoutes = BASE_EXPORTS.privateRouteTableIds.map((exportName, index) => new ec2.CfnRoute(
      this, `PrivateDefaultRoute${index + 1}`, {
        routeTableId: importBase(exportName),
        destinationCidrBlock: '0.0.0.0/0',
        natGatewayId: this.natGateway.ref,
      },
    ));

    // The S3 gateway endpoint moves here with the egress routes: while the
    // environment is stopped there is no gateway endpoint, so S3 access from the
    // Private tier requires this stack. It attaches to the Base-owned route
    // tables, exactly like the default routes.
    this.s3GatewayEndpoint = new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcId,
      routeTableIds: BASE_EXPORTS.privateRouteTableIds.map(importBase),
    });

    new cdk.CfnOutput(this, 'EgressNatGatewayId', { value: this.natGateway.ref });
    new cdk.CfnOutput(this, 'EgressNatEipAllocationId', { value: this.natEip.attrAllocationId });
    new cdk.CfnOutput(this, 'EgressPrivateRouteTableIds', {
      value: cdk.Fn.join(',', BASE_EXPORTS.privateRouteTableIds.map(importBase)),
    });
  }
}
