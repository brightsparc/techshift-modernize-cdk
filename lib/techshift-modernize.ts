import cdk = require('@aws-cdk/cdk');
import iam = require('@aws-cdk/aws-iam')
import logs = require('@aws-cdk/aws-logs');
import ec2 = require('@aws-cdk/aws-ec2');
import ecs = require('@aws-cdk/aws-ecs');
import dis = require('@aws-cdk/aws-servicediscovery');
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import cloudwatch = require('@aws-cdk/aws-cloudwatch');

export class TechshiftModernize extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: "/cdk/fargate",
      retentionDays: 30,
    })

    const vpc = new ec2.VpcNetwork(this, 'MyVpc', {
      maxAZs: 2,
      cidr: "10.1.0.0/16",
    });

    // Manually add service discovery
    // see: https://github.com/awslabs/aws-cdk/issues/1554

    const ns = new dis.CfnPrivateDnsNamespace(this, 'MyCfnDns', {
      name: "cdk-ecslab",
      vpc: vpc.vpcId,
    })
    const discovery = new dis.CfnService(this, 'MyCfnService', {
      name: 'cdk-mysql-service',
      dnsConfig: {
        dnsRecords: [ {
          type: "A",
          ttl: "60"
        }],
        namespaceId: ns.privateDnsNamespaceId,
      },
      healthCheckCustomConfig: {
        failureThreshold: 1
      }
    })

    const cluster = new ecs.Cluster(this, 'MyCluster', {
      vpc: vpc
    });

    // Add EC2 capacity to cluster
    const autoScalingGroup = cluster.addDefaultAutoScalingGroupCapacity({
      instanceType: new ec2.InstanceType('t2.small'),
      instanceCount: 2,
      maxCapacity: 4,
      // Give instances 5 minutes to drain running tasks when an instance is
      // terminated. This is the default, turn this off by specifying 0 or
      // change the timeout up to 900 seconds.
      taskDrainTimeSeconds: 60,  
    });   

    // TODO: Look at scaling out to track a custom metric such as when deploying
    
    autoScalingGroup.scaleOnCpuUtilization('KeepCpuHalfwayLoaded', {
      targetUtilizationPercent: 50
    });

    const mysqlTaskDefinition = new ecs.FargateTaskDefinition(this, 'MySqlTaskDef', {
      family: 'MySqlTask',
      memoryMiB: '512',
      cpu: '256'
    });

    const mysqlContainer = mysqlTaskDefinition.addContainer("MySql", {
      image: ecs.ContainerImage.fromDockerHub("mysql:5.7"),
      memoryLimitMiB: 512, // Hard limit
      cpu: 256,
      essential: true,
      environment: { 
        'MYSQL_ROOT_PASSWORD': 'password' 
      },
      logging: new ecs.AwsLogDriver(this, 'MySqlLogs', { 
        logGroup: logGroup,
        streamPrefix: 'mysql' 
      })
    });

    mysqlContainer.addPortMappings({
      containerPort: 3306,
      hostPort: 3306,
    })

    const mySqlService = new ecs.FargateService(this, 'MySqlService', {
      cluster,
      serviceName: "MySql",
      taskDefinition: mysqlTaskDefinition,
      desiredCount: 1,
    });
    
    // Allow all MySQL traffic
    mySqlService.connections.allowFromAnyIPv4(new ec2.TcpPort(3306))

    // Register with service discovery
    var hook = ((<any>mySqlService).resource as ecs.CfnService);
    hook.propertyOverrides.serviceRegistries = [{
      registryArn: discovery.serviceArn
    }];

    // TODO: Code deploy is support in CFN or CDK yet, need custom resource to update serivce
    // see: https://github.com/awslabs/aws-cdk/issues/1559

    const wordpressExecutionRole = new iam.Role(this, 'WordpressTaskDefExecutionRole', {
      roleName: "WordpressTaskDefExecutionRole",
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    wordpressExecutionRole.attachManagedPolicy('arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy')

    const wordpressTaskDefinition = new ecs.Ec2TaskDefinition(this, 'WordpressTaskDef', {
      family: 'WordpressTask',
      executionRole: wordpressExecutionRole,
      //memoryMiB: '512',
      //cpu: '256',
    });

    const wordpressContainer = wordpressTaskDefinition.addContainer("Wordpress", {
      image: ecs.ContainerImage.fromDockerHub("wordpress:4.9"),
      memoryLimitMiB: 512, // Hard limit
      cpu: 256,
      essential: true,
      environment: { 
        'WORDPRESS_DB_HOST': 'cdk-mysql-service.cdk-ecslab',
        'WORDPRESS_DB_PASSWORD': 'password'
      },
      logging: new ecs.AwsLogDriver(this, 'WordpressLogs', { 
        logGroup: logGroup,
        streamPrefix: 'wordpress' 
      }),
    });

    wordpressContainer.addPortMappings({
      hostPort: 0, // Use dynamic port
      containerPort: 80,
    })

    const wordpressService = new ecs.Ec2Service(this, 'WordpressService', { 
      cluster,
      serviceName: "Wordpress",
      taskDefinition: wordpressTaskDefinition,
      desiredCount: 2, 
      minimumHealthyPercent: 0, // Allow killing one instance to roll in
      maximumPercent: 200 // Allow twice
    });

    // Configure specific connection for this security group
    // wordpressService.connections.allowTo(mySqlService.connections, 
    //   new ec2.TcpPortRange(3306, 3306), "wordpress to mysql")

    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', { 
      vpc,
      internetFacing: true
    });
    const listener = lb.addListener('Listener', { port: 80 });
    const target = listener.addTargets('ECS', {
      port: 80,
      targets: [wordpressService],
      healthCheck: {
        port: 'traffic-port', // Use traffic port since we have dynamic host
        intervalSecs: 30,
        timeoutSeconds: 5,
        healthyThresholdCount: 5,
        unhealthyThresholdCount: 2,
        healthyHttpCodes: "200,301,302" // Allow for redirects
      }
    });

    new cloudwatch.Alarm(this, 'TargetGroup5xx', {
      metric: target.metricHttpCodeTarget(elbv2.HttpCodeTarget.Target5xxCount),
      threshold: 1,
      evaluationPeriods: 2,
    });    
           
    // Output the DNS where you can access your service
    new cdk.Output(this, 'LoadBalancerDNS', { value: lb.dnsName });

  }
}
