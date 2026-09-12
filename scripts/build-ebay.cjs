'use strict';
const fs=require('node:fs');
const path=require('node:path');
// Fail the build if runtime dependencies are missing, instead of publishing
// a page whose API only fails when the first user opens it.
require('../lib/ebay/core');
require('pg');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'dist-ebay','ebay');
fs.mkdirSync(output,{recursive:true});
// Only these public assets are deployed; never publish the repository root,
// server modules, environment files, local helper, SQL, or existing AI APIs.
for(const name of ['index.html','app.js','style.css']) {
  fs.copyFileSync(path.join(root,'ebay',name),path.join(output,name));
}
