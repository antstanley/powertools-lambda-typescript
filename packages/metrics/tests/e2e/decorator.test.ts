// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test metrics standard functions
 *
 * @group e2e/metrics/decorator
 */

import { randomUUID } from 'crypto';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import { Tracing } from '@aws-cdk/aws-lambda';
import { App, Stack } from '@aws-cdk/core';
import { SdkProvider } from 'aws-cdk/lib/api/aws-auth';
import { CloudFormationDeployments } from 'aws-cdk/lib/api/cloudformation-deployments';
import * as AWS from 'aws-sdk';
import { MetricUnits } from '../../src';
import { getMetrics } from '../helpers/metricsUtils';

const ONE_MINUTE = 1000 * 60;

const cloudwatchClient = new AWS.CloudWatch();
const lambdaClient = new AWS.Lambda();

const integTestApp = new App();
const stack = new Stack(integTestApp, 'MetricsE2EDecoratorStack');

// GIVEN
const invocationCount = 2;
const startTime = new Date();
const expectedNamespace = randomUUID(); // to easily find metrics back at assert phase
const expectedServiceName = 'decoratorService';
const expectedMetricName = 'MyMetric';
const expectedMetricUnit = MetricUnits.Count;
const expectedMetricValue = '1';
const expectedDefaultDimensions = { MyDimension: 'MyValue' };
const expectedExtraDimension = { MyExtraDimension: 'MyExtraValue' };
const expectedSingleMetricDimension = { MySingleMetricDim: 'MySingleValue' };
const expectedSingleMetricName = 'MySingleMetric';
const expectedSingleMetricUnit = MetricUnits.Percent;
const expectedSingleMetricValue = '2';
const functionName = 'MyFunctionWithDecoratedHandler';
new lambda.NodejsFunction(stack, 'MyFunction', {
  functionName: functionName,
  tracing: Tracing.ACTIVE,
  environment: {
    EXPECTED_NAMESPACE: expectedNamespace,
    EXPECTED_SERVICE_NAME: expectedServiceName,
    EXPECTED_METRIC_NAME: expectedMetricName,
    EXPECTED_METRIC_UNIT: expectedMetricUnit,
    EXPECTED_METRIC_VALUE: expectedMetricValue,
    EXPECTED_DEFAULT_DIMENSIONS: JSON.stringify(expectedDefaultDimensions),
    EXPECTED_EXTRA_DIMENSION: JSON.stringify(expectedExtraDimension),
    EXPECTED_SINGLE_METRIC_DIMENSION: JSON.stringify(expectedSingleMetricDimension),
    EXPECTED_SINGLE_METRIC_NAME: expectedSingleMetricName,
    EXPECTED_SINGLE_METRIC_UNIT: expectedSingleMetricUnit,
    EXPECTED_SINGLE_METRIC_VALUE: expectedSingleMetricValue,
  },
});

const stackArtifact = integTestApp.synth().getStackByName(stack.stackName);

describe('happy cases', () => {
  beforeAll(async () => {
    const sdkProvider = await SdkProvider.withAwsCliCompatibleDefaults({
      profile: process.env.AWS_PROFILE,
    });
    const cloudFormation = new CloudFormationDeployments({ sdkProvider });

    // WHEN
    // lambda function is deployed
    await cloudFormation.deployStack({
      stack: stackArtifact,
      quiet: true,
    });

    // and invoked
    for (let i = 0; i < invocationCount; i++) {
      await lambdaClient
        .invoke({
          FunctionName: functionName,
        })
        .promise();
    }

  }, ONE_MINUTE * 3);

  it('capture ColdStart Metric', async () => {
    const expectedDimensions = [
      { Name: 'service', Value: expectedServiceName },
      { Name: 'function_name', Value: functionName },
      { Name: Object.keys(expectedDefaultDimensions)[0], Value: expectedDefaultDimensions.MyDimension },
    ];
    // Check coldstart metric dimensions
    const coldStartMetrics = await getMetrics(cloudwatchClient, expectedNamespace, 'ColdStart', 1);

    expect(coldStartMetrics.Metrics?.length).toBe(1);
    const coldStartMetric = coldStartMetrics.Metrics?.[0];
    expect(coldStartMetric?.Dimensions).toStrictEqual(expectedDimensions);

    // Check coldstart metric value
    const adjustedStartTime = new Date(startTime.getTime() - 60 * 1000);
    const endTime = new Date(new Date().getTime() + 60 * 1000);
    console.log(`Manual command: aws cloudwatch get-metric-statistics --namespace ${expectedNamespace} --metric-name ColdStart --start-time ${Math.floor(adjustedStartTime.getTime()/1000)} --end-time ${Math.floor(endTime.getTime()/1000)} --statistics 'Sum' --period 60 --dimensions '${JSON.stringify(expectedDimensions)}'`);
    const coldStartMetricStat = await cloudwatchClient
      .getMetricStatistics(
        {
          Namespace: expectedNamespace,
          StartTime: adjustedStartTime, 
          Dimensions: expectedDimensions,
          EndTime: endTime,
          Period: 60,
          MetricName: 'ColdStart',
          Statistics: ['Sum'],
        },
        undefined
      )
      .promise();

    // Despite lambda has been called twice, coldstart metric sum should only be 1
    const singleDataPoint = coldStartMetricStat.Datapoints ? coldStartMetricStat.Datapoints[0] : {};
    expect(singleDataPoint?.Sum).toBe(1);
  }, ONE_MINUTE * 3);

  it('produce added Metric with the default and extra one dimensions', async () => {
    // Check metric dimensions
    const metrics = await getMetrics(cloudwatchClient, expectedNamespace, expectedMetricName, 1);

    expect(metrics.Metrics?.length).toBe(1);
    const metric = metrics.Metrics?.[0];
    const expectedDimensions = [
      { Name: 'service', Value: expectedServiceName },
      { Name: Object.keys(expectedDefaultDimensions)[0], Value: expectedDefaultDimensions.MyDimension },
      { Name: Object.keys(expectedExtraDimension)[0], Value: expectedExtraDimension.MyExtraDimension },
    ];
    expect(metric?.Dimensions).toStrictEqual(expectedDimensions);

    // Check coldstart metric value
    const adjustedStartTime = new Date(startTime.getTime() - 3 * ONE_MINUTE);
    const endTime = new Date(new Date().getTime() + ONE_MINUTE);
    console.log(`Manual command: aws cloudwatch get-metric-statistics --namespace ${expectedNamespace} --metric-name ${expectedMetricName} --start-time ${Math.floor(adjustedStartTime.getTime()/1000)} --end-time ${Math.floor(endTime.getTime()/1000)} --statistics 'Sum' --period 60 --dimensions '${JSON.stringify(expectedDimensions)}'`);
    const metricStat = await cloudwatchClient
      .getMetricStatistics(
        {
          Namespace: expectedNamespace,
          StartTime: adjustedStartTime,
          Dimensions: expectedDimensions,
          EndTime: endTime,
          Period: 60,
          MetricName: expectedMetricName,
          Statistics: ['Sum'],
        },
        undefined
      )
      .promise();

    // Since lambda has been called twice in this test and potentially more in others, metric sum should be at least of expectedMetricValue * invocationCount
    const singleDataPoint = metricStat.Datapoints ? metricStat.Datapoints[0] : {};
    expect(singleDataPoint?.Sum).toBeGreaterThanOrEqual(parseInt(expectedMetricValue) * invocationCount);
  }, ONE_MINUTE * 3);

  afterAll(async () => {
    if (!process.env.DISABLE_TEARDOWN) {
      const stackArtifact = integTestApp.synth().getStackByName(stack.stackName);

      const sdkProvider = await SdkProvider.withAwsCliCompatibleDefaults({
        profile: process.env.AWS_PROFILE,
      });
      const cloudFormation = new CloudFormationDeployments({ sdkProvider });

      await cloudFormation.destroyStack({
        stack: stackArtifact,
        quiet: true,
      });
    }
  }, ONE_MINUTE * 3);
});