import {build} from 'esbuild';
import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {outputFolder,run,zipDirectory,directoryBytes,writeNotices,copyTree} from './package-utils.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('目前的便携包构建脚本仅支持 Windows x64。');
const pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const runtime=[process.env.QINGCHUAN_NODE_EXE,path.join(root,'.runtime/node.exe'),path.join(root,'runtime/node.exe'),process.execPath].filter(Boolean).find(file=>existsSync(file));
const version=execFileSync(runtime,['--version'],{encoding:'utf8',windowsHide:true}).trim();
const [major,minor]=version.slice(1).split('.').map(Number);
if(major<22||(major===22&&minor<18))throw new Error('打包需要 Node.js >=22.18.0。');
run(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--config','vite.local.config.ts'],{cwd:root});
const output=outputFolder('portable'),name=`qingchuan-${pkg.version}-windows-x64`,bundle=path.join(output,name);
for(const folder of ['scripts','runtime','db'])mkdirSync(path.join(bundle,folder),{recursive:true});
await build({entryPoints:[path.join(root,'scripts/local-server.mjs')],outfile:path.join(bundle,'scripts/local-server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',minify:true,legalComments:'inline',external:['bufferutil','utf-8-validate'],banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"}});
copyTree(path.join(root,'dist-local'),path.join(bundle,'dist-local'));
if(!existsSync(path.join(bundle,'dist-local/index.html')))throw new Error('Portable web assets missing.');
copyFileSync(runtime,path.join(bundle,'runtime/node.exe'));
for(const file of ['scripts/start-local.ps1','scripts/stop-local.ps1','启动轻传.cmd','停止轻传.cmd','db/schema.sql','README.md'])copyFileSync(path.join(root,file),path.join(bundle,file));
const customLicense=process.env.QINGCHUAN_NODE_LICENSE;
const bundledLicense=path.join(root,'.runtime/NODE-LICENSE.txt');
let nodeLicense;
if(customLicense)nodeLicense=readFileSync(customLicense);
else if(version==='v22.23.5'&&existsSync(bundledLicense))nodeLicense=readFileSync(bundledLicense);
else{
  const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`);
  if(!response.ok)throw new Error('无法取得对应 Node.js 许可文本，请用 QINGCHUAN_NODE_LICENSE 指定文件。');
  nodeLicense=Buffer.from(await response.arrayBuffer());
}
writeFileSync(path.join(bundle,'runtime/NODE-LICENSE.txt'),nodeLicense);
writeNotices(root,path.join(bundle,'third-party-licenses'));
writeFileSync(path.join(bundle,'使用说明.txt'),'\ufeff轻传 Windows 便携版\r\n\r\n1. 解压整个文件夹。\r\n2. 双击“启动轻传.cmd”。\r\n3. 手机和电脑连接同一 Wi-Fi 或热点，扫码配对。\r\n4. 两端均可发送照片；收到后请下载保存。多图优先下载 ZIP。\r\n5. 双击“停止轻传.cmd”结束本地服务。\r\n\r\n无需安装 Node.js 或运行 npm。runtime 目录不能单独删除。\r\n首次可能需要允许 Windows 防火墙的局域网访问。\r\n本地 HTTP 未加密，请在可信网络使用。更多说明见 README.md。\r\n');
const zip=path.join(output,name+'.zip');zipDirectory(bundle,zip);
const report={version:pkg.version,nodeVersion:version,folder:bundle,zip,unpackedBytes:directoryBytes(bundle),zipBytes:statSync(zip).size};
writeFileSync(path.join(output,'package-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
