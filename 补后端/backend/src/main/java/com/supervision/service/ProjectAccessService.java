package com.supervision.service;

import com.supervision.common.AuthContext;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.criteria.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

/** 服务端按项目授权；兼容旧人员单项目分配，显式停用成员后不再回退。 */
@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class ProjectAccessService {
    private final EntityManager em;

    public User currentUser() {
        Long id = AuthContext.getUserId();
        if (id == null) throw new BusinessException(401, "请先登录");
        User user = em.find(User.class, id);
        if (user == null || !"active".equals(user.getStatus())) throw new BusinessException(401, "账号不可用，请重新登录");
        return user;
    }

    public boolean isAdmin() {
        User user = currentUser();
        return em.createQuery("select count(ur) from UserRole ur, Role r where ur.roleId=r.id and ur.userId=:uid and r.code='admin'", Long.class)
                .setParameter("uid", user.getId()).getSingleResult() > 0;
    }

    public void requireAdmin() {
        if (!isAdmin()) throw new BusinessException(403, "仅管理员可以维护项目授权");
    }

    public List<Long> projectIds(boolean reviewOnly) {
        User user = currentUser();
        List<Project> projects = activeProjects();
        if (isAdmin()) return projects.stream().map(Project::getId).toList();
        Map<Long, ProjectMember> memberships = new HashMap<>();
        em.createQuery("select m from ProjectMember m where m.userId=:uid", ProjectMember.class)
                .setParameter("uid", user.getId()).getResultList().forEach(m -> memberships.put(m.getProjectId(), m));
        return projects.stream().filter(p -> {
            ProjectMember member = memberships.get(p.getId());
            if (member != null) return member.isEnabled() && (!reviewOnly || member.isCanReview());
            if (Objects.equals(p.getManagerId(), user.getId())) return true;
            return !reviewOnly && Objects.equals(user.getProjectId(), p.getId());
        }).map(Project::getId).toList();
    }

    private List<Project> activeProjects() {
        return em.createQuery("select p from Project p where p.status <> 'inactive'", Project.class).getResultList();
    }

    /** 可见绑定口径（与 projectIds 一致、不含管理员/负责人推导）：启用的显式成员行优先，无成员行时回退旧所属项目字段 */
    private List<Long> boundProjectIds(User user, Map<Long, ProjectMember> memberships, List<Project> projects) {
        List<Long> ids = new ArrayList<>();
        for (Project p : projects) {
            ProjectMember member = memberships.get(p.getId());
            if (member != null) { if (member.isEnabled()) ids.add(p.getId()); }
            else if (Objects.equals(user.getProjectId(), p.getId())) ids.add(p.getId());
        }
        return ids;
    }

    /** 人员管理页编辑回显：单人当前生效的项目 ID 列表（以数据库为准） */
    public List<Long> userProjectIds(Long userId) {
        requireAdmin();
        User user = em.find(User.class, userId);
        if (user == null) throw new BusinessException(404, "人员不存在");
        Map<Long, ProjectMember> memberships = new HashMap<>();
        em.createQuery("select m from ProjectMember m where m.userId=:uid", ProjectMember.class)
                .setParameter("uid", userId).getResultList().forEach(m -> memberships.put(m.getProjectId(), m));
        return boundProjectIds(user, memberships, activeProjects());
    }

    /** 人员管理页列表“分配项目”列：一次取齐 userId→项目 ID 映射，避免逐行请求 */
    public Map<Long, List<Long>> userProjectMap() {
        requireAdmin();
        List<Project> projects = activeProjects();
        Map<Long, List<ProjectMember>> grouped = new HashMap<>();
        em.createQuery("select m from ProjectMember m", ProjectMember.class).getResultList()
                .forEach(m -> grouped.computeIfAbsent(m.getUserId(), k -> new ArrayList<>()).add(m));
        Map<Long, List<Long>> result = new LinkedHashMap<>();
        for (User user : em.createQuery("select u from User u where u.status <> 'inactive'", User.class).getResultList()) {
            Map<Long, ProjectMember> memberships = new HashMap<>();
            grouped.getOrDefault(user.getId(), List.of()).forEach(m -> memberships.put(m.getProjectId(), m));
            List<Long> ids = boundProjectIds(user, memberships, projects);
            if (!ids.isEmpty()) result.put(user.getId(), ids);
        }
        return result;
    }

    /**
     * 人员编辑“分配项目”整体替换：已勾选的保留成员行及其审核授权不动，
     * 取消勾选的删除成员行，新增勾选的按“成员、无审核权”补建（审核权仍由项目成员面板显式授予）。
     * projectIds 为 null 表示旧客户端未传列表，不触碰显式绑定。
     */
    @Transactional
    public void syncUserProjects(Long userId, List<Long> projectIds) {
        if (projectIds == null) return;
        requireAdmin();
        User user = em.find(User.class, userId);
        if (user == null) throw new BusinessException(404, "人员不存在");
        Map<Long, Project> projects = new HashMap<>();
        activeProjects().forEach(p -> projects.put(p.getId(), p));
        LinkedHashSet<Long> target = new LinkedHashSet<>();
        for (Long pid : projectIds) {
            if (pid == null) continue;
            if (!projects.containsKey(pid)) throw new BusinessException(400, "项目不存在或已停用：id=" + pid);
            target.add(pid);
        }
        List<ProjectMember> existing = em.createQuery("select m from ProjectMember m where m.userId=:uid", ProjectMember.class)
                .setParameter("uid", userId).getResultList();
        Set<Long> existingProjectIds = new HashSet<>();
        for (ProjectMember m : existing) {
            existingProjectIds.add(m.getProjectId());
            if (target.contains(m.getProjectId())) m.setEnabled(true);
            else em.remove(m);
        }
        for (Long pid : target) {
            if (existingProjectIds.contains(pid)) continue;
            ProjectMember member = new ProjectMember();
            member.setProjectId(pid);
            member.setUserId(userId);
            member.setEnabled(true);
            member.setCanReview(false);
            em.persist(member);
        }
        OperationLog event = new OperationLog();
        event.setModule("项目授权");
        event.setAction("人员所属项目整体调整");
        event.setUserId(currentUser().getId());
        event.setDetail("userId=" + userId + ", projectIds=" + target);
        em.persist(event);
    }

    public void requireRead(Long projectId) {
        if (projectId == null || !projectIds(false).contains(projectId)) throw new BusinessException(403, "无权访问该项目");
    }

    public boolean canReview(Long projectId) { return projectIds(true).contains(projectId); }

    public void requireEdit(Long projectId, Long authorId) {
        requireRead(projectId);
        if (!Objects.equals(authorId, currentUser().getId()) && !canReview(projectId))
            throw new BusinessException(403, "仅本人或项目审核人可以修改该记录");
    }

    public void requireReview(Long projectId) {
        if (!canReview(projectId)) throw new BusinessException(403, "没有该项目的审核权限");
    }

    public Predicate scope(Root<?> root, CriteriaBuilder cb) {
        List<Long> ids = projectIds(false);
        return ids.isEmpty() ? cb.disjunction() : root.get("projectId").in(ids);
    }

    public List<Map<String, Object>> members(Long projectId) {
        requireAdmin();
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProjectMember m : em.createQuery("select m from ProjectMember m where m.projectId=:pid", ProjectMember.class)
                .setParameter("pid", projectId).getResultList()) {
            User user = em.find(User.class, m.getUserId());
            result.add(Map.of("userId", m.getUserId(), "userName", user == null ? "已移除人员" : user.getName(),
                    "enabled", m.isEnabled(), "canReview", m.isCanReview()));
        }
        return result;
    }

    @Transactional
    public ProjectMember setMember(Long projectId, Long userId, boolean enabled, boolean canReview) {
        requireAdmin();
        Project project = em.find(Project.class, projectId, jakarta.persistence.LockModeType.PESSIMISTIC_WRITE);
        if (project == null || "inactive".equals(project.getStatus())) throw new BusinessException(404, "项目不存在");
        User user = em.find(User.class, userId);
        if (user == null) throw new BusinessException(404, "人员不存在");
        ProjectMember member = em.createQuery("select m from ProjectMember m where m.projectId=:pid and m.userId=:uid", ProjectMember.class)
                .setParameter("pid", projectId).setParameter("uid", userId).getResultStream().findFirst().orElseGet(ProjectMember::new);
        member.setProjectId(projectId);
        member.setUserId(userId);
        member.setEnabled(enabled);
        member.setCanReview(canReview);
        if (member.getId() == null) em.persist(member);
        OperationLog event = new OperationLog();
        event.setModule("项目授权");
        event.setAction("成员授权变更");
        event.setUserId(currentUser().getId());
        event.setDetail("projectId=" + projectId + ", userId=" + userId + ", enabled=" + enabled + ", canReview=" + canReview);
        em.persist(event);
        return member;
    }
}
