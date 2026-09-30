// What each MCP tool does, in the words the switches show. The same 31 tools
// exist on this computer (the plugin) and behind a shared bridge (the server).
export const TOOL_INFO = {
  "server_info": {
    "group": "상태",
    "access": "read",
    "description": "MCP 브리지의 주소, 기본 Workspace·Peer, 읽기 전용 여부와 Honcho 연결 상태를 한 번에 확인합니다.",
    "useCase": "연결 문제 진단이나 에이전트의 기본 조회 범위를 확인할 때",
    "offImpact": "에이전트가 브리지 설정과 상태를 스스로 진단할 수 없습니다."
  },
  "get_queue_status": {
    "group": "상태",
    "access": "read",
    "description": "메시지에서 사실과 추론을 만드는 Deriver 작업의 완료·진행·대기 수를 조회합니다.",
    "useCase": "새 기억이 아직 처리 중인지, 추론 생성이 밀렸는지 확인할 때",
    "offImpact": "에이전트가 기억 처리 완료 여부를 확인할 수 없습니다."
  },
  "inspect_workspace": {
    "group": "Workspace",
    "access": "read",
    "description": "지정한 Workspace의 생성 정보, 설정과 metadata를 포함한 상세 항목을 조회합니다.",
    "useCase": "현재 기억 저장소의 정확한 설정과 식별자를 점검할 때",
    "offImpact": "Workspace 상세 진단이 불가능해집니다."
  },
  "list_workspaces": {
    "group": "Workspace",
    "access": "read",
    "description": "Honcho에 존재하는 Workspace를 필터와 함께 나열해 사용할 기억 저장소를 찾습니다.",
    "useCase": "여러 프로젝트나 사용자 기억 중 조회 대상을 선택할 때",
    "offImpact": "에이전트가 사용 가능한 Workspace를 탐색할 수 없습니다."
  },
  "search": {
    "group": "기억",
    "access": "read",
    "description": "대화 원문을 의미 기반으로 검색합니다. Workspace 전체 또는 특정 Peer·Session 범위로 좁힐 수 있습니다.",
    "useCase": "과거 발언, 결정의 근거, 정확한 대화 맥락을 넓게 찾을 때",
    "offImpact": "원문 기억을 자율적으로 탐색하는 핵심 경로가 사라집니다."
  },
  "get_metadata": {
    "group": "기억",
    "access": "read",
    "description": "Workspace, Peer 또는 Session에 붙은 구조화 metadata를 범위별로 조회합니다.",
    "useCase": "태그, 외부 식별자, 애플리케이션별 부가 정보를 확인할 때",
    "offImpact": "구조화된 부가 정보를 읽을 수 없습니다."
  },
  "set_metadata": {
    "group": "기억",
    "access": "write",
    "description": "Workspace, Peer 또는 Session의 metadata와 일부 configuration을 새 값으로 갱신합니다.",
    "useCase": "태그, 외부 식별자나 애플리케이션 설정을 에이전트가 직접 관리할 때",
    "offImpact": "에이전트가 metadata를 읽을 수는 있지만 수정할 수 없습니다."
  },
  "create_peer": {
    "group": "Peer",
    "access": "write",
    "description": "현재 Workspace에 새로운 사람·에이전트·프로젝트 등의 Peer를 생성합니다.",
    "useCase": "새로운 기억 주체를 등록하고 Session에 참여시키기 전에",
    "offImpact": "에이전트가 새 Peer를 만들 수 없습니다."
  },
  "list_peers": {
    "group": "Peer",
    "access": "read",
    "description": "Workspace 안의 사용자·에이전트 등 모든 Peer를 나열하고 대상의 존재 여부를 확인합니다.",
    "useCase": "누구의 관점이나 기억을 조회할지 결정할 때",
    "offImpact": "에이전트가 사용 가능한 Peer를 탐색할 수 없습니다."
  },
  "chat": {
    "group": "Peer",
    "access": "llm",
    "description": "Dialectic LLM이 축적된 Conclusion과 문맥을 탐색해 특정 Peer에 관한 자연어 답변을 생성합니다.",
    "useCase": "검색 결과를 직접 조립하지 않고 Honcho의 추론형 답변이 필요할 때",
    "offImpact": "에이전트가 Dialectic 답변을 요청할 수 없습니다."
  },
  "get_peer_card": {
    "group": "Peer",
    "access": "read",
    "description": "Peer를 설명하는 짧고 구조화된 특성 카드와 핵심 속성을 조회합니다.",
    "useCase": "대상 인물의 성향과 핵심 특성을 빠르게 파악할 때",
    "offImpact": "간결한 Peer 요약을 사용할 수 없습니다."
  },
  "set_peer_card": {
    "group": "Peer",
    "access": "write",
    "description": "Peer의 핵심 특성을 담는 Peer card를 직접 지정하거나 기존 카드 내용을 교체합니다.",
    "useCase": "자동 생성 결과 대신 명시적인 인물 요약을 저장할 때",
    "offImpact": "Peer card 조회만 가능하고 수정은 할 수 없습니다."
  },
  "get_peer_context": {
    "group": "Peer",
    "access": "read",
    "description": "Representation과 Peer card를 묶어 LLM이 바로 사용할 수 있는 대상 중심 문맥을 만듭니다.",
    "useCase": "한 번의 호출로 개인화된 답변 문맥을 확보할 때",
    "offImpact": "에이전트가 Peer 통합 문맥을 직접 조립해야 합니다."
  },
  "get_representation": {
    "group": "Peer",
    "access": "read",
    "description": "관찰자가 특정 Peer를 어떻게 이해하는지 축적된 사실·추론을 바탕으로 서술형 표현을 생성합니다.",
    "useCase": "사용자의 성향, 관심사, 관계나 변화에 관해 답할 때",
    "offImpact": "Honcho의 고차원 인물 이해를 직접 조회할 수 없습니다."
  },
  "create_session": {
    "group": "Session",
    "access": "write",
    "description": "참여 Peer와 관찰 관계를 지정해 새로운 대화 Session을 생성합니다.",
    "useCase": "새 대화 흐름이나 문서 수집 단위를 시작할 때",
    "offImpact": "에이전트가 새 Session을 만들 수 없습니다."
  },
  "list_sessions": {
    "group": "Session",
    "access": "read",
    "description": "Workspace의 대화 Session을 필터와 페이지 단위로 나열합니다.",
    "useCase": "관련 대화 묶음을 찾거나 최근 Session을 탐색할 때",
    "offImpact": "에이전트가 Session 목록을 탐색할 수 없습니다."
  },
  "delete_session": {
    "group": "Session",
    "access": "danger",
    "description": "지정한 Session과 그 Session에 속한 기록을 Honcho에서 삭제합니다.",
    "useCase": "잘못 만든 대화 묶음이나 보존할 필요가 없는 기록을 정리할 때",
    "offImpact": "에이전트가 Session을 삭제할 수 없습니다."
  },
  "clone_session": {
    "group": "Session",
    "access": "write",
    "description": "기존 Session의 참여 구조와 메시지를 바탕으로 별도의 새 Session 사본을 만듭니다.",
    "useCase": "원본을 보존한 채 분기된 실험이나 문맥을 만들 때",
    "offImpact": "에이전트가 Session을 복제할 수 없습니다."
  },
  "add_peers_to_session": {
    "group": "Session",
    "access": "write",
    "description": "기존 Session에 Peer를 추가하고 서로를 관찰할 수 있는 범위를 설정합니다.",
    "useCase": "대화 도중 새 사용자나 에이전트를 참여시킬 때",
    "offImpact": "Session 참여자를 추가할 수 없습니다."
  },
  "remove_peers_from_session": {
    "group": "Session",
    "access": "write",
    "description": "기존 Session에서 지정한 Peer의 참여 관계를 제거합니다.",
    "useCase": "더 이상 해당 대화 문맥에 포함할 필요가 없는 Peer를 분리할 때",
    "offImpact": "Session 참여자를 제거할 수 없습니다."
  },
  "get_session_peers": {
    "group": "Session",
    "access": "read",
    "description": "특정 Session에 참여한 Peer와 상호 관찰 설정을 조회합니다.",
    "useCase": "대화 참여자와 각 관점의 관계를 이해할 때",
    "offImpact": "Session 참여 구조를 확인할 수 없습니다."
  },
  "inspect_session": {
    "group": "Session",
    "access": "read",
    "description": "Session의 활성 상태, 설정, metadata 등 대화 묶음의 상세 정보를 조회합니다.",
    "useCase": "Session 범위와 상태를 정확히 진단할 때",
    "offImpact": "Session 상세 상태를 읽을 수 없습니다."
  },
  "add_messages_to_session": {
    "group": "Session",
    "access": "write",
    "description": "하나 이상의 메시지를 Peer, 시각, metadata와 함께 Session에 기록하고 기억 처리를 시작합니다.",
    "useCase": "새 대화, 이벤트, 문서 조각을 장기 기억으로 저장할 때",
    "offImpact": "에이전트가 Honcho에 새 기억을 기록할 수 없습니다."
  },
  "get_session_messages": {
    "group": "Session",
    "access": "read",
    "description": "특정 Session의 메시지를 순서·페이지 조건과 함께 조회해 전체 대화 흐름을 복원합니다.",
    "useCase": "긴 대화를 시간순으로 읽거나 여러 메시지를 비교할 때",
    "offImpact": "Session 단위 대화 원문을 묶어서 읽을 수 없습니다."
  },
  "get_session_message": {
    "group": "Session",
    "access": "read",
    "description": "메시지 ID로 원문 한 건과 작성 Peer, 생성 시각 등 정확한 기록을 조회합니다.",
    "useCase": "검색 결과의 특정 발언을 정밀하게 검증할 때",
    "offImpact": "개별 메시지의 정확한 원문 확인이 제한됩니다."
  },
  "get_session_context": {
    "group": "Session",
    "access": "read",
    "description": "메시지와 선택한 Peer의 표현·카드를 결합해 LLM 입력용 Session 문맥을 구성합니다.",
    "useCase": "특정 대화에 근거한 답변을 한 번의 호출로 준비할 때",
    "offImpact": "Session 기반 답변 문맥을 자동 구성할 수 없습니다."
  },
  "list_conclusions": {
    "group": "Conclusion",
    "access": "read",
    "description": "Deriver가 대화에서 추출한 사실과 추론을 관찰자·대상·Session 조건으로 나열합니다.",
    "useCase": "Honcho가 이미 알고 있는 명시적 사실과 판단을 검토할 때",
    "offImpact": "도출된 기억을 목록 형태로 읽을 수 없습니다."
  },
  "query_conclusions": {
    "group": "Conclusion",
    "access": "read",
    "description": "도출된 Conclusion만을 의미 검색해 원문 검색보다 압축된 고수준 기억을 찾습니다.",
    "useCase": "반복 패턴, 성향, 결정 같은 추론 중심 질문에 답할 때",
    "offImpact": "고수준 기억을 의미 기반으로 탐색할 수 없습니다."
  },
  "create_conclusions": {
    "group": "Conclusion",
    "access": "write",
    "description": "관찰자와 대상 Peer 사이의 사실·추론을 Conclusion으로 직접 저장합니다.",
    "useCase": "Deriver를 기다리지 않고 검증된 인사이트를 명시적으로 기억시킬 때",
    "offImpact": "에이전트가 Conclusion을 직접 추가할 수 없습니다."
  },
  "delete_conclusion": {
    "group": "Conclusion",
    "access": "danger",
    "description": "Conclusion ID로 특정 사실이나 추론 기록을 영구적으로 삭제합니다.",
    "useCase": "틀렸거나 더 이상 유지하면 안 되는 파생 기억을 제거할 때",
    "offImpact": "에이전트가 잘못된 Conclusion을 직접 삭제할 수 없습니다."
  },
  "schedule_dream": {
    "group": "상태",
    "access": "llm",
    "description": "축적된 Conclusion을 다시 검토해 더 높은 수준의 패턴과 추론을 만드는 Dream 작업을 예약합니다.",
    "useCase": "새로운 고차 추론이나 장기 패턴 갱신이 필요할 때",
    "offImpact": "에이전트가 Dream 처리를 직접 예약할 수 없습니다."
  }
};

export const TOOL_GROUPS = ["기억", "Peer", "Session", "Conclusion", "Workspace", "상태"];
