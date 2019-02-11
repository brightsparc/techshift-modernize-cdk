# Techshift Modernize CDK code

This repo contains the code deploy the [techshift modernize](https://kapilpendse.github.io/techshift-accelerator-content/) stack with all the compontents.

# Infrastructure as code

The repo contains examples of how to model this service with the [AWS Cloud Development Kit (AWS)](https://github.com/awslabs/aws-cdk) and provision the service with AWS CloudFormation.

To deploy the Typescript example, run the following.  

```
npm install
npm run build
npm run synth-service
```

Deploy the resulting CloudFormation templates with 

```
npm run deploy-service
```
