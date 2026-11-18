import {copyFileSync,cpSync,mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {outputFolder,zipDirectory,directoryBytes,copyTree} from './package-utils.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const output=outputFolder('source'),name=`qingchuan-${pkg.version}-source`,bundle=path.join(output,name);mkdirSync(bundle,{recursive:true});
const files=['README.md','.gitignore','.npmrc','package.json','package-lock.json','tsconfig.json','vite.local.config.ts','postcss.config.mjs','index.html','local-client.tsx','启动轻传.cmd','停止轻传.cmd'];
const directories=['app','lib','db','public','scripts','tests'];
for(const file of files)copyFileSync(path.join(root,file),path.join(bundle,file));
for(const directory of directories)copyTree(path.join(root,directory),path.join(bundle,directory));
for(const file of ['app/page.tsx','scripts/local-server.mjs','db/schema.sql'])statSync(path.join(bundle,file));
const zip=path.join(output,name+'.zip');zipDirectory(bundle,zip);
const report={version:pkg.version,folder:bundle,zip,unpackedBytes:directoryBytes(bundle),zipBytes:statSync(zip).size};
writeFileSync(path.join(output,'source-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
