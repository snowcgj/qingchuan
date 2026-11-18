import {existsSync,mkdirSync,readdirSync,readFileSync,statSync,lstatSync,copyFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function outputFolder(kind){
  const index=process.argv.indexOf('--output');
  const base=path.resolve(index>=0?process.argv[index+1]:'release');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const result=path.join(base,`${kind}-${stamp}`);mkdirSync(result,{recursive:true});return result;
}
export function run(executable,args,options={}){
  const result=spawnSync(executable,args,{stdio:'inherit',windowsHide:true,...options});
  if(result.error)throw result.error;if(result.status!==0)throw new Error(`Command failed (${result.status}): ${path.basename(executable)}`);
}
export function zipDirectory(directory,zip){
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const command=`$ProgressPreference = 'SilentlyContinue'; Compress-Archive -LiteralPath ${quote(directory)} -DestinationPath ${quote(zip)} -CompressionLevel Optimal`;
  run('powershell.exe',['-NoLogo','-NoProfile','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')]);
}
export function directoryBytes(directory){let bytes=0;for(const entry of readdirSync(directory,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);bytes+=entry.isDirectory()?directoryBytes(file):statSync(file).size}return bytes;}
export function copyTree(source,target){
  if(lstatSync(source).isSymbolicLink())throw new Error('Refusing to package a symbolic link: '+source);
  if(statSync(source).isDirectory()){
    mkdirSync(target,{recursive:true});
    for(const entry of readdirSync(source))copyTree(path.join(source,entry),path.join(target,entry));
  }else{
    mkdirSync(path.dirname(target),{recursive:true});copyFileSync(source,target);
  }
}
export function writeNotices(root,directory){
  mkdirSync(directory,{recursive:true});
  const lock=JSON.parse(readFileSync(path.join(root,'package-lock.json'),'utf8'));
  const lines=['# Third-party notices','','Copies of license texts for runtime dependencies. The Node.js runtime has its own NODE-LICENSE.txt.',''];
  for(const [relative,info] of Object.entries(lock.packages||{})){
    if(!relative.startsWith('node_modules/')||info.dev)continue;
    const folder=path.join(root,relative);if(!existsSync(path.join(folder,'package.json')))continue;
    const pkg=JSON.parse(readFileSync(path.join(folder,'package.json'),'utf8'));
    for(const name of readdirSync(folder).filter(name=>/^(licen[sc]e|copying|notice)(\.(txt|md))?$/i.test(name))){
      const source=path.join(folder,name);if(!statSync(source).isFile())continue;
      const target=(pkg.name+'-'+name).replace(/[^a-zA-Z0-9._-]/g,'_');
      writeFileSync(path.join(directory,target),readFileSync(source));
      lines.push(`- ${pkg.name} ${pkg.version}: [${name}](${target})`);
    }
  }
  writeFileSync(path.join(directory,'README.md'),lines.join('\n')+'\n');
}
