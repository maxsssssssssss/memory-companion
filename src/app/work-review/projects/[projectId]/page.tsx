import type {Metadata} from "next";
import {WorkAgentPage} from "@/components/work-review/work-agent-page";
export const metadata:Metadata={title:"项目会议衔接 · 工作复盘"};
export default async function Page({params,searchParams}:{params:Promise<{projectId:string}>;searchParams:Promise<{meeting?:string;prepareMeeting?:string}>}){
  const [{projectId},{meeting,prepareMeeting}]=await Promise.all([params,searchParams]);
  return <WorkAgentPage key={projectId} projectId={projectId} meetingId={typeof meeting==="string"?meeting:undefined} prepareMeetingId={typeof prepareMeeting==="string"?prepareMeeting:undefined}/>;
}
