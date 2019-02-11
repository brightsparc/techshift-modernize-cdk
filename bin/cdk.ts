#!/usr/bin/env node
import cdk = require('@aws-cdk/cdk');
import { TechshiftModernize } from '../lib/techshift-modernize';

const app = new cdk.App();
new TechshiftModernize(app, 'TechShiftModernize');
app.run();
