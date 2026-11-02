package com.supervision.repository;

import com.supervision.entity.SafetyLog;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

@Repository
public interface SafetyLogRepository extends JpaRepository<SafetyLog, Long>, JpaSpecificationExecutor<SafetyLog> {

    Optional<SafetyLog> findByCode(String code);

    @org.springframework.data.jpa.repository.Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    Optional<SafetyLog> findFirstBySourceRecordIdAndStatusNotOrderByIdAsc(Long sourceRecordId, String status);

    Page<SafetyLog> findByProjectId(Long projectId, Pageable pageable);

    Page<SafetyLog> findByAuthorId(Long authorId, Pageable pageable);

    Page<SafetyLog> findByStatus(String status, Pageable pageable);

    Page<SafetyLog> findByLogDateBetween(LocalDate startDate, LocalDate endDate, Pageable pageable);

    List<SafetyLog> findByProjectId(Long projectId);

    List<SafetyLog> findByAuthorId(Long authorId);

    List<SafetyLog> findByStatus(String status);

    List<SafetyLog> findByLogDateBetween(LocalDate startDate, LocalDate endDate);
}
